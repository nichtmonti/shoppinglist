import { writeFileSync } from 'node:fs';
import type { CDPSession, Page, TestInfo } from '@playwright/test';

// What a page was doing when a test failed on it, for the failures a page
// snapshot cannot explain ([D-247]). A rare hang has hit the browser harnesses
// since September: right after a full page load the page never became usable,
// and the test timed out without a snapshot, which Playwright cannot take of a
// page that is mid-navigation or whose main thread is blocked. The three
// suspects (the service worker stalling the navigation, IndexedDB held by the
// page being left, a loop on the main thread) leave different traces, so this
// records the history as it happens and probes the page's state at the end.
//
// Every probe has its own short deadline: a blocked page must make the report
// say so, not stall it. The report goes to <test output dir>/page-diagnosis.md,
// which CI's e2e-failure-context step prints, since the CI server keeps no
// artifacts.

const KEEP = 30;
const PROBE_MS = 2_000;

interface Recorder {
	readonly page: Page;
	readonly started: number;
	console: string[];
	errors: string[];
	navigations: string[];
	inFlight: Map<object, { method: string; url: string; type: string; at: number }>;
	debugger: Promise<Debugger | null>;
}

const recorders = new WeakMap<Page, Recorder>();

const since = (r: Recorder) => `+${((Date.now() - r.started) / 1000).toFixed(1)}s`;
const push = (list: string[], line: string) => {
	list.push(line);
	if (list.length > KEEP) list.shift();
};

/** Starts recording `page`'s console, errors, navigations and requests. Idempotent. */
export function watchPage(page: Page): void {
	if (recorders.has(page)) return;
	const r: Recorder = {
		page,
		started: Date.now(),
		console: [],
		errors: [],
		navigations: [],
		inFlight: new Map(),
		debugger: attachDebugger(page)
	};
	recorders.set(page, r);
	page.on('console', (m) => push(r.console, `${since(r)} [${m.type()}] ${m.text().slice(0, 300)}`));
	page.on('pageerror', (e) => push(r.errors, `${since(r)} ${String(e).slice(0, 500)}`));
	page.on('framenavigated', (f) => {
		if (f === page.mainFrame()) push(r.navigations, `${since(r)} ${f.url()}`);
	});
	page.on('request', (q) =>
		r.inFlight.set(q, { method: q.method(), url: q.url(), type: q.resourceType(), at: Date.now() })
	);
	page.on('requestfinished', (q) => r.inFlight.delete(q));
	page.on('requestfailed', (q) => r.inFlight.delete(q));
}

/** The part of CDP's Debugger.paused event the report reads. */
interface PausedEvent {
	reason: string;
	callFrames: {
		functionName: string;
		url?: string;
		location: { scriptId: string; lineNumber: number; columnNumber?: number };
	}[];
}

/** A debugger on the page, enabled while it is healthy: enabling waits for
 *  the main thread, so on a blocked page only the pause (an interrupt) gets
 *  through. Script URLs by id, for the stack. */
interface Debugger {
	session: CDPSession;
	scripts: Map<string, string>;
}

async function attachDebugger(page: Page): Promise<Debugger | null> {
	try {
		const session = await page.context().newCDPSession(page);
		const scripts = new Map<string, string>();
		session.on('Debugger.scriptParsed', (e) => scripts.set(e.scriptId, e.url));
		await session.send('Debugger.enable');
		return { session, scripts };
	} catch {
		return null;
	}
}

/**
 * Pauses the page in the debugger and says where: the stack, with the code
 * around the top frame (the build ships no source maps, so the minified text
 * is what identifies it), or that no JavaScript ran within the deadline, so
 * the thread is idle and the page is waiting on something else. Resumes it.
 */
async function pauseStack(r: Recorder | undefined): Promise<string> {
	const dbg = r ? await within(r.debugger) : null;
	if (!dbg || dbg === 'timed out') return '- no debugger on this page';
	const { session, scripts } = dbg;
	try {
		const paused = new Promise<PausedEvent>((resolve) => session.once('Debugger.paused', resolve));
		await within(session.send('Debugger.pause'));
		const event = await within(paused, 3_000);
		if (event === 'timed out') {
			return '- no JavaScript ran within 3 s: the thread is idle, so the page is waiting (a load or a request), not looping';
		}
		const frames = event.callFrames.slice(0, 12).map((f) => {
			const { scriptId, lineNumber, columnNumber = 0 } = f.location;
			const url = scripts.get(scriptId) || f.url || scriptId;
			return `- ${f.functionName || '(anonymous)'} ${url}:${lineNumber + 1}:${columnNumber + 1}`;
		});
		const top = event.callFrames[0]?.location;
		let excerpt = '';
		if (top) {
			const source = await within(
				session.send('Debugger.getScriptSource', { scriptId: top.scriptId })
			);
			if (source !== 'timed out') {
				const line = source.scriptSource.split('\n')[top.lineNumber] ?? '';
				const at = top.columnNumber ?? 0;
				excerpt = `\n\nAround the top frame:\n\n\`\`\`js\n${line.slice(Math.max(0, at - 200), at)}⟨here⟩${line.slice(at, at + 200)}\n\`\`\``;
			}
		}
		return `Paused (${event.reason}):\n\n${frames.join('\n')}${excerpt}`;
	} catch (e) {
		return `- the debugger failed: ${String(e)}`;
	} finally {
		await within(
			session.send('Debugger.resume').catch(() => undefined),
			1_000
		);
	}
}

function within<T>(promise: Promise<T>, ms = PROBE_MS): Promise<T | 'timed out'> {
	return Promise.race([
		promise,
		new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms))
	]);
}

/** The report for `page`, every probe bounded. */
export async function diagnose(page: Page, reason: string): Promise<string> {
	const r = recorders.get(page);
	const out: string[] = [`# Page diagnosis: ${reason}`, ''];
	out.push(
		`- at: ${new Date().toISOString()}${r ? ` (${since(r)} after the page was watched)` : ''}`
	);
	out.push(`- page closed: ${page.isClosed()}`);
	if (page.isClosed()) return out.join('\n');
	out.push(`- url (Playwright): ${page.url()}`);

	// The main thread: a page whose JS is blocked answers nothing at all.
	const alive = await within(
		page.evaluate(() => performance.now()).catch((e: unknown) => `error: ${String(e)}`)
	);
	out.push(
		`- main thread: ${typeof alive === 'number' ? 'responds' : `does NOT respond (${alive})`}`
	);
	// Unanswered is two different things: a loop that never yields, or a
	// page still loading, where Playwright has no context to evaluate in. The
	// debugger tells them apart: a busy thread pauses at once, in the loop.
	if (typeof alive !== 'number')
		out.push('', '## Where the main thread is', '', await pauseStack(r));

	if (typeof alive === 'number') {
		const state = await within(
			page
				.evaluate(async () => {
					const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
					const sw = (w: ServiceWorker | null | undefined) =>
						w ? `${w.state} ${w.scriptURL}` : '-';
					const locks = await Promise.race([
						navigator.locks?.query().then((q) => ({
							held: (q.held ?? []).map((l) => `${l.name} (${l.mode})`),
							pending: (q.pending ?? []).map((l) => `${l.name} (${l.mode})`)
						})),
						new Promise((resolve) => setTimeout(() => resolve('query timed out'), 1000))
					]);
					const dbs = await Promise.race([
						indexedDB.databases?.().then((d) => d.map((x) => `${x.name} v${x.version}`)),
						new Promise((resolve) => setTimeout(() => resolve('query timed out'), 1000))
					]);
					return {
						readyState: document.readyState,
						title: document.title,
						bodyText: document.body?.innerText.length ?? 0,
						elements: document.querySelectorAll('*').length,
						testIds: [...document.querySelectorAll('[data-testid]')]
							.slice(0, 25)
							.map((e) => e.getAttribute('data-testid')),
						controller: sw(navigator.serviceWorker?.controller),
						registration: reg
							? { active: sw(reg.active), waiting: sw(reg.waiting), installing: sw(reg.installing) }
							: '-',
						locks,
						dbs
					};
				})
				.catch((e: unknown) => `error: ${String(e)}`),
			4_000
		);
		out.push('', '## Page state', '', '```json', JSON.stringify(state, null, 2), '```');
	}

	const workers = page
		.context()
		.serviceWorkers()
		.map((w) => w.url());
	out.push(
		'',
		`## Service workers in the context`,
		'',
		workers.length ? workers.map((u) => `- ${u}`).join('\n') : '- none'
	);
	if (r) {
		const open = [...r.inFlight.values()].map(
			(q) => `- ${q.method} ${q.url} [${q.type}] (open ${((Date.now() - q.at) / 1000).toFixed(1)}s)`
		);
		out.push(
			'',
			'## Requests still open',
			'',
			typeof alive === 'number'
				? ''
				: '(The main thread is blocked, so a request it never saw finish stays listed.)\n',
			open.length ? open.join('\n') : '- none'
		);
		out.push(
			'',
			'## Last main-frame navigations',
			'',
			...(r.navigations.length ? r.navigations : ['- none'])
		);
		out.push('', '## Page errors', '', ...(r.errors.length ? r.errors : ['- none']));
		out.push('', '## Last console messages', '', ...(r.console.length ? r.console : ['- none']));
	}
	return out.join('\n');
}

async function report(page: Page, testInfo: TestInfo, reason: string, file: string): Promise<void> {
	const text = await diagnose(page, reason).catch((e: unknown) => `diagnosis failed: ${String(e)}`);
	try {
		writeFileSync(testInfo.outputPath(file), text);
	} catch {
		// the output dir may be gone at teardown; the log line below still carries it
	}
	console.log(`\n===== ${file} (${testInfo.title}) =====\n${text}\n`);
}

/**
 * Watches `page` for one test; the returned function writes a diagnosis if the
 * test failed. Call it after the test, from a fixture's teardown or an
 * afterEach: Playwright runs those after a timeout too, page still open.
 */
export function guardTest(page: Page, testInfo: TestInfo): () => Promise<void> {
	watchPage(page);
	return async () => {
		if (testInfo.status !== testInfo.expectedStatus) {
			await report(page, testInfo, `the test ended ${testInfo.status}`, 'page-diagnosis.md');
		}
	};
}
