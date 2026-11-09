import { expect, type Download, type FileChooser, type Locator, type Page } from '@playwright/test';

// The dead-controls walk engine (dead-controls.spec.ts declares the surfaces).
// See the spec's header for the method and why it is safe to run.

// ---- controls this walk must never press --------------------------------
//
// Every other destructive action in the app opens a ConfirmDialog/AlertDialog
// first, and this walk only ever clicks TRIGGERS, never the confirm button
// inside one (role="alertdialog" subtrees are excluded from enumeration
// below) — "Überall abmelden" among them since [D-214]. The per-device
// sign-out acts directly from the settings screen with no confirmation step.
const NEVER_CLICK_NAMES = new Set<string>([
	// Local per-device sign-out — ends the session immediately with no
	// confirmation.
	'Auf diesem Gerät abmelden'
]);

// Controls skipped by data-testid rather than by name, because their
// accessible name is dynamic (carries the item's own name and a relative
// "when" string that can legitimately tick between reads).
const NEVER_CLICK_TESTIDS = new Set<string>([
	// "Frühere Artikel" one-tap re-add: pulls the item permanently off the
	// previous-items bucket and back onto the active list. Re-adding is
	// already the exact behaviour previous-items.spec.ts pins; walking it here
	// too would just deplete this test's own previous-items fixture as the
	// walk progresses, for no extra coverage.
	'prev-item'
]);

// ---- generic "did anything observable happen" signature ------------------

// Deliberately NOT part of this: document.activeElement. Clicking a <button>
// focuses it — that is the browser, not the app responding — so "the focused
// element changed" is true after virtually every click and would make every
// click read as a change, leaving the gate with no teeth.
// Focus is still checked, but only as "did focus land somewhere OTHER than the
// control we just clicked" — see focusMovedAway() below.
interface Signature {
	url: string;
	domHash: number;
	effects: number;
}

/**
 * What changes on its own timers, after whichever control caused it, and so
 * would hand the change to a LATER control's verdict: a toast closing (7s), and
 * the sync state settling (the outbox drains 500ms after a write, which can be
 * after the next control's baseline settled): the chip, and a home card's
 * unsynced badge. Left out of
 * every hash; a toast appearing still counts, as an effect (installEffectSpies).
 */
const NOISE = '[data-sonner-toaster], .chip[role="status"], [data-testid="card-unsynced"]';

/**
 * Hash of the WHOLE document element, not just <body> (a theme/locale flip can
 * change only <html>'s class/lang), less NOISE and whatever matches `skip`;
 * with `only`, of what the elements it matches hold instead.
 * Walked from the DOM rather than taken from outerHTML: svelte 5 marks an {#if}
 * block with comment anchors and swaps `<!--[-->` for `<!--[!-->` when the
 * block empties, so comments are skipped and text is trimmed, and only real
 * content counts.
 */
async function pageHash(page: Page, skip: string | null, only?: string): Promise<number> {
	return page.evaluate(
		({ noise, skip, only }) => {
			const leaveOut = skip ? `${noise}, ${skip}` : noise;
			const serialise = (node: Node): string => {
				let out = '';
				for (const child of Array.from(node.childNodes)) {
					if (child.nodeType === Node.COMMENT_NODE) continue;
					if (child.nodeType === Node.TEXT_NODE) {
						out += (child.nodeValue ?? '').trim();
						continue;
					}
					const el = child as HTMLElement;
					if (el.matches?.(leaveOut)) continue;
					out += '<' + el.tagName;
					for (const attr of Array.from(el.attributes)) out += ' ' + attr.name + '=' + attr.value;
					out += '>' + serialise(el) + '</' + el.tagName + '>';
				}
				return out;
			};
			const html = only
				? Array.from(document.querySelectorAll(only), serialise).join('|')
				: '<HTML' +
					Array.from(document.documentElement.attributes)
						.map((a) => ` ${a.name}=${a.value}`)
						.join('') +
					'>' +
					serialise(document.documentElement);
			let h = 0;
			for (let i = 0; i < html.length; i++) h = (h * 31 + html.charCodeAt(i)) | 0;
			return h;
		},
		{ noise: NOISE, skip, only }
	);
}

/**
 * A read that failed because a navigation destroyed the page it ran in is the
 * control's doing; any other failure is the walk's own and is thrown.
 */
function navigated(error: unknown): true {
	if (/context was destroyed|navigat/i.test(String(error))) return true;
	throw error;
}

/** The URL and the effect count, without the page hash. */
async function readUrlEffects(page: Page): Promise<{ url: string; effects: number }> {
	const [url, effects] = await page.evaluate(() => {
		const fx = (
			window as unknown as {
				__e2eEffects?: { clipboard: number; share: number; open: number; toasts: number };
			}
		).__e2eEffects;
		return [location.href, fx ? fx.clipboard + fx.share + fx.open + fx.toasts : 0] as const;
	});
	return { url, effects };
}

/** window.__e2eEffects is installed by installEffectSpies(). */
async function readSignature(page: Page): Promise<Signature> {
	return { ...(await readUrlEffects(page)), domHash: await pageHash(page, null) };
}

function sigEqual(a: Signature, b: Signature): boolean {
	return a.url === b.url && a.domHash === b.domHash && a.effects === b.effects;
}

/** Waits until two 250ms-apart reads agree, so background churn (a sync
 *  banner settling, a relative-time tick) is not mistaken for a click's own
 *  effect — and so it cannot mask a genuinely dead control either. */
async function stableSignature(page: Page): Promise<Signature> {
	let last = await readSignature(page);
	for (let i = 0; i < 30; i++) {
		await page.waitForTimeout(250);
		const next = await readSignature(page);
		if (sigEqual(last, next)) return next;
		last = next;
	}
	throw new Error('page signature never settled — background churn unrelated to the walk?');
}

/**
 * Did focus land somewhere OTHER than the control that was clicked?
 *
 * This is the part of "focus changed" that actually means the app did
 * something: §9.1's shop-view '+' moves focus into the add bar, and moving
 * focus IS its effect. A control merely receiving focus because it was clicked
 * is the browser's doing and says nothing about whether it is wired up.
 *
 * Called ONLY after the signature came back unchanged, which matters for two
 * reasons. It is the cheap order — a control that visibly did something needs
 * no focus question asked — and it is the correct one: locator.evaluate()
 * AUTO-WAITS for its element and the harness sets no action timeout, so
 * probing a control that has navigated away would wait out the whole test
 * timeout without an assertion error. An unchanged signature means the
 * control is still there to ask; the explicit timeout is the backstop.
 */
async function focusMovedAway(locator: Locator): Promise<boolean> {
	return locator
		.evaluate(
			(el) => {
				const active = document.activeElement;
				if (active === null || active === document.body) return false;
				return active !== el && !el.contains(active);
			},
			undefined,
			{ timeout: 2_000 }
		)
		.catch(() => false);
}

/**
 * Hash of the page with the walked control's OWN markup taken out, and with
 * the group a stateful control belongs to.
 *
 * A control that deletes itself changes the document, so the whole-document
 * hash counts it as alive no matter how useless it is — e.g. an app-bar '+'
 * that only flips `list_view` and thereby removes itself, with no add bar on
 * screen ([D-127]). Asked when the control has VANISHED, the question becomes
 * the honest one: did anything change besides this thing disappearing? A tile
 * check-off still passes (its item turns up in the done section); a
 * self-deleting no-op does not.
 *
 * A radio, tab, checkbox or switch is asked the same question while it is
 * still there: bits-ui keeps its own state, so the group's aria-checked and
 * data-state move on any click, wired or not. Only a change outside the group
 * shows the app answered (the view swapping, the import's count). Any other
 * control still present is judged on the whole document: a picker whose job is
 * to show its new state would fail a check that excluded its own subtree.
 */
async function restHash(page: Page): Promise<number> {
	return pageHash(page, '[data-dead-walk], [data-dead-walk-group]');
}

/**
 * What a tab's panels hold. bits-ui shows and hides the panels from its own
 * value, and the sheet around them reflows with that, so nothing outside the
 * panels is the app's answer; their content is, rendered from the app's value
 * (Segmented renders a panel only for it).
 */
async function panelHash(page: Page): Promise<number> {
	return pageHash(page, null, '[data-dead-walk-panel]');
}

/** The hash a control that is gone, or keeps its own state, is judged on. */
function contentHash(page: Page, kind: Kind): Promise<number> {
	return kind === 'tab' ? panelHash(page) : restHash(page);
}

/**
 * Did anything happen that the control's own disappearance does not explain?
 *
 * ONE poll that re-asks which comparison applies on every tick, because
 * whether the control survives is not known when the click returns: a removal
 * can wait on a Dexie write, a liveQuery and a re-render, and sampling once
 * would take the "still here" branch and then count the removal itself as the
 * change ([D-127]).
 *
 *   control still present -> the whole-document signature must move
 *   control gone, or one  -> the URL, an effect, or the page MINUS its markup
 *   that keeps its own       (and its group) must move; for a tab, what its
 *   state                    panels hold
 *
 * A self-deleting no-op polls present-and-unchanged, then gone-and-unchanged
 * once its markup is discounted, through to the deadline -> dead.
 */
async function observedChange(
	page: Page,
	before: Signature,
	beforeRest: number,
	kind: Kind
): Promise<boolean> {
	const deadline = Date.now() + 2_500;
	for (;;) {
		const gone = (await page.locator('[data-dead-walk]').count()) === 0;
		if (gone || kind === 'stateful' || kind === 'tab') {
			const now = await readUrlEffects(page).catch(navigated);
			if (now === true || now.url !== before.url || now.effects !== before.effects) return true;
			const rest = await contentHash(page, kind).catch(navigated);
			if (rest === true || rest !== beforeRest) return true;
		} else {
			const now = await readSignature(page).catch(navigated);
			if (now === true || !sigEqual(now, before)) return true;
		}
		if (Date.now() >= deadline) return false;
		await page.waitForTimeout(100);
	}
}

/**
 * Did a menu item do anything, against `closed`: the page with its menu shut
 * and nothing picked? A menu closes on any selection, so the plain verdict
 * passes every item, wired or not. Compared once the menu is gone and nothing
 * still swallows clicks; a dialog the item opened is its answer.
 */
async function observedAfterMenu(page: Page, closed: Signature): Promise<boolean> {
	const deadline = Date.now() + 2_500;
	for (;;) {
		const state = await page
			.evaluate(() => {
				if (document.querySelector('[role="menu"]')) return 'open';
				if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return 'dialog';
				const blocked = (el: Element): boolean => getComputedStyle(el).pointerEvents === 'none';
				return blocked(document.documentElement) || blocked(document.body) ? 'closing' : 'shut';
			})
			.catch((error: unknown) => navigated(error) && 'navigated');
		if (state === 'dialog' || state === 'navigated') return true;
		if (state === 'shut') {
			const now = await readSignature(page).catch(navigated);
			if (now === true || !sigEqual(now, closed)) return true;
		}
		if (Date.now() >= deadline) return false;
		await page.waitForTimeout(100);
	}
}

/** Wraps navigator.clipboard.writeText / navigator.share / window.open so a
 *  control whose only effect is one of those still counts as "not dead" —
 *  and so a real window.open() never actually pops a window mid-walk. */
export async function installEffectSpies(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const w = window as unknown as {
			__e2eEffects: { clipboard: number; share: number; open: number; toasts: number };
		};
		w.__e2eEffects = { clipboard: 0, share: 0, open: 0, toasts: 0 };
		// A toast is an answer (NOISE leaves the toaster out of every hash).
		new MutationObserver((records) => {
			for (const r of records) {
				for (const n of Array.from(r.addedNodes)) {
					// The first toast arrives inside the list svelte-sonner mounts for it.
					if (!(n instanceof Element)) continue;
					const toast = '[data-sonner-toast]';
					w.__e2eEffects.toasts += n.matches(toast) ? 1 : n.querySelectorAll(toast).length;
				}
			}
		}).observe(document, { childList: true, subtree: true });
		try {
			const clip = (navigator as unknown as { clipboard?: { writeText?: unknown } }).clipboard;
			if (clip && typeof clip.writeText === 'function') {
				const orig = (clip.writeText as (t: string) => Promise<void>).bind(clip);
				clip.writeText = (text: string) => {
					w.__e2eEffects.clipboard++;
					return orig(text).catch(() => {});
				};
			}
		} catch {
			// clipboard not available in this context — nothing to spy on.
		}
		(navigator as unknown as { share: (data?: unknown) => Promise<void> }).share = (
			data?: unknown
		) => {
			w.__e2eEffects.share++;
			return Promise.resolve(data as void);
		};
		window.open = (...args: unknown[]) => {
			w.__e2eEffects.open++;
			void args;
			return null;
		};
	});
}

// ---- overlays leave whole ([D-349]) ---------------------------------------

/**
 * Watches every dialog and sheet the walk opens and closes: one that finished
 * opening must animate out, and keep its content while it does. A fault is
 * recorded as it happens, and walkSurface() reads them before each control:
 *
 * - "left without animating out": mounted only while open (`{#if}`), it went
 *   with its state. One closed mid-entrance is not judged: bits-ui drops it
 *   at once.
 * - "emptied as it closed": it had fewer elements when its exit started than
 *   just before, its content read off the open value, which the close made
 *   null.
 */
export async function watchOverlays(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const OVERLAY = '[role="dialog"], [role="alertdialog"]';
		const w = window as unknown as { __e2eOverlayFaults: string[] };
		w.__e2eOverlayFaults = [];
		const seen = new WeakSet<Element>();
		const opened = new WeakSet<Element>();
		const exiting = new WeakSet<Element>();
		const openSize = new WeakMap<Element, number>();
		const size = (el: Element) => el.querySelectorAll('*').length;
		const name = (el: Element) =>
			el.querySelector('[data-dialog-title], [data-alert-dialog-title]')?.textContent?.trim() ||
			'(no title)';
		const running = (el: Element, keyframes: string) =>
			el.getAnimations().filter((a) => (a as CSSAnimation).animationName === keyframes);
		// Read off the elements, as bits-ui reads them: an `animationstart` right
		// after an `animationend` on the same element is not always dispatched.
		new MutationObserver((records) => {
			for (const el of Array.from(document.querySelectorAll(OVERLAY))) {
				const state = (el as HTMLElement).dataset.state;
				if (state === 'open') {
					// Its size while open, last taken before the mutations that close it.
					openSize.set(el, size(el));
					if (!seen.has(el)) {
						seen.add(el);
						// Opened once its entrance has run; one cut short is not judged.
						void Promise.all(running(el, 'enter').map((a) => a.finished))
							.then(() => opened.add(el))
							.catch(() => {});
					}
				} else if (state === 'closed' && !exiting.has(el) && running(el, 'exit').length > 0) {
					exiting.add(el);
					const before = openSize.get(el);
					if (before !== undefined && size(el) < before) {
						w.__e2eOverlayFaults.push(
							`"${name(el)}" emptied as it closed (${before} → ${size(el)} elements)`
						);
					}
				}
			}
			for (const r of records) {
				for (const n of Array.from(r.removedNodes)) {
					if (!(n instanceof Element)) continue;
					for (const el of [n, ...Array.from(n.querySelectorAll(OVERLAY))]) {
						if (el.matches(OVERLAY) && opened.has(el) && !exiting.has(el)) {
							w.__e2eOverlayFaults.push(`"${name(el)}" left without animating out`);
						}
					}
				}
			}
		}).observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['data-state']
		});
	});
}

/** Fails on what watchOverlays() recorded since the last call, and clears it. */
async function expectOverlaysLeftWhole(page: Page, surface: string, after: string): Promise<void> {
	const faults = await page.evaluate(() => {
		const w = window as unknown as { __e2eOverlayFaults?: string[] };
		const found = w.__e2eOverlayFaults ?? [];
		w.__e2eOverlayFaults = [];
		return found;
	});
	expect(
		faults,
		`${surface}: after ${after}, a dialog or sheet did not leave whole ([D-349]): ` +
			'mounted only while open, or its content read off the open value instead of a Kept'
	).toEqual([]);
}

/** Waits out every entrance under way, so the walk's Escape closes an opened
 *  overlay, which watchOverlays() judges, not one still arriving. */
async function settleEntrances(page: Page): Promise<void> {
	await page
		.evaluate(() =>
			Promise.all(
				document
					.getAnimations()
					.filter((a) => (a as CSSAnimation).animationName === 'enter')
					.map((a) => a.finished.catch(() => {}))
			)
		)
		.catch(() => {});
}

// ---- enumerating & relocating controls ------------------------------------

interface ControlDesc {
	role: string;
	name: string;
	testid: string | null;
}

/** Every visible, enabled, clickable control actually rendered under `scope`
 *  right now — never one revealed by clicking something else first (the
 *  spec's header says why that is the safety property this walk relies on). */
async function enumerateControls(scope: Locator): Promise<ControlDesc[]> {
	return scope.evaluate((root) => {
		const nodes = Array.from(
			root.querySelectorAll<HTMLElement>(
				'button, a[href], [role="radio"], [role="switch"], [role="checkbox"], ' +
					'[role="menuitem"], [role="menuitemradio"], [role="tab"]'
			)
		);
		function visible(el: HTMLElement): boolean {
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return false;
			const s = getComputedStyle(el);
			return s.visibility !== 'hidden' && s.display !== 'none';
		}
		// `el.textContent` is NOT the accessible name: it includes text inside
		// aria-hidden decoration (e.g. PrevItemsLink's 🕘 glyph and trailing ›
		// chevron, both explicitly aria-hidden — #lib/components/common/
		// PrevItemsLink.svelte), which Playwright's own getByRole name
		// matching correctly excludes. Using raw textContent here would
		// compute a name this walk could never actually relocate the control
		// by, since every re-establish() looks it up through getByRole.
		function accName(el: HTMLElement): string {
			// aria-labelledby wins over aria-label, as in the accessible-name
			// computation: a settings row is named by its label and value only,
			// its grey line being the description ([D-269]).
			const labelledBy = el.getAttribute('aria-labelledby');
			if (labelledBy !== null) {
				return labelledBy
					.split(/\s+/)
					.map((id) => document.getElementById(id)?.textContent ?? '')
					.join(' ')
					.trim()
					.replace(/\s+/g, ' ');
			}
			const label = el.getAttribute('aria-label');
			if (label !== null) return label.trim().replace(/\s+/g, ' ');
			function visibleText(node: Node): string {
				let text = '';
				for (const child of Array.from(node.childNodes)) {
					if (child.nodeType === Node.TEXT_NODE) {
						text += child.textContent ?? '';
					} else if (child.nodeType === Node.ELEMENT_NODE) {
						const childEl = child as HTMLElement;
						if (childEl.getAttribute('aria-hidden') === 'true') continue;
						text += visibleText(childEl);
					}
				}
				return text;
			}
			return visibleText(el).trim().replace(/\s+/g, ' ');
		}
		function roleOf(el: HTMLElement): string {
			return el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : 'button');
		}
		return (
			nodes
				.filter(visible)
				// Never descend into an open confirm/alert dialog — its trigger is
				// what gets walked, never the destructive button inside it.
				.filter((el) => !el.closest('[role="alertdialog"]'))
				// Transient toast UI churns on its own timers; it is not part of the
				// app's control surface.
				.filter((el) => !el.closest('[data-sonner-toaster]'))
				// An external link (another origin) is the browser's own navigation,
				// not app code: an <a href> cannot be dead the way an unwired button
				// can, and whether a new tab opens under a headless harness is the
				// environment's business, not something the walk can rely on.
				.filter((el) => {
					if (el.tagName !== 'A') return true;
					const href = (el as HTMLAnchorElement).href;
					return !href || new URL(href, location.href).origin === location.origin;
				})
				.filter((el) => !(el as HTMLButtonElement).disabled)
				.filter((el) => el.getAttribute('aria-disabled') !== 'true')
				.filter((el) => {
					// LOAD-BEARING SKIP: an already-selected segment of a radio-style
					// picker (role=radio/tab/menuitemradio, aria-checked/aria-selected
					// ="true") asks for the state it is already in, and that state is
					// visibly indicated — that is not a dead button. A segment that
					// renders as active WITHOUT being the current state would hide
					// here, which is why the spec's previous-items test asserts the
					// view toggle's aria-checked state directly.
					const role = roleOf(el);
					if (role === 'radio' || role === 'tab' || role === 'menuitemradio') {
						return (
							el.getAttribute('aria-checked') !== 'true' &&
							el.getAttribute('aria-selected') !== 'true'
						);
					}
					return true;
				})
				.map((el) => ({
					role: roleOf(el),
					name: accName(el),
					testid: el.getAttribute('data-testid')
				}))
		);
	});
}

interface OccurrenceDesc extends ControlDesc {
	occurrence: number;
}

/**
 * Same testid, many DIFFERENT rows: the identical "tile"/"row"/"done-row"/
 * "prev-item" testid repeats once per item, so it cannot tell one item's
 * control apart from another's — only the item's own name can. That name is
 * stable across re-establish (nothing this walk clicks renames an item), but
 * the SET of rows is not: checking a tile off (or hiding a category, or
 * re-adding a previous item) removes it from its list, which shifts every
 * OTHER row's position in DOM order — and a per-item control uses no testid
 * of its own for exactly that reason (the categories' pencil/hide buttons).
 * A testid-keyed occurrence index would then quietly relocate to a
 * DIFFERENT row than the one originally enumerated. Name-based keying does
 * not have that problem: each row's own name IS the disambiguator.
 *
 * Everything else (a handful of this app's own triggers) is the opposite
 * case: a SINGLE control whose accessible name carries derived state —
 * SortMenu's "{label}: {selected option}" (#lib/components/common/
 * SortMenu.svelte), a done-section toggle's own count ("Erledigt {n}"),
 * PrevItemsLink's optional count suffix. A control walked earlier in the
 * same pass can rename one of these out from under a name-based lookup (e.g.
 * checking a tile off relabels the "Erledigt" toggle for every LATER
 * control's re-establish). Its testid never moves, so that is the key here.
 */
const PER_ITEM_TESTIDS = new Set(['tile', 'row', 'done-row', 'prev-item']);

function keyByTestid(testid: string | null): boolean {
	return testid !== null && !PER_ITEM_TESTIDS.has(testid);
}

/** Same-named controls (e.g. every category row's identical "hide" button)
 *  are told apart by their position among same-key matches, so each gets
 *  relocated deterministically after every re-establish. */
function withOccurrence(list: ControlDesc[]): OccurrenceDesc[] {
	const seen = new Map<string, number>();
	return list.map((c) => {
		const key = keyByTestid(c.testid) ? `testid::${c.testid}` : `${c.role}::${c.name}`;
		const occurrence = seen.get(key) ?? 0;
		seen.set(key, occurrence + 1);
		return { ...c, occurrence };
	});
}

/** Relocates a control the same way withOccurrence() keyed it. */
function locateControl(scope: Locator, desc: OccurrenceDesc): Locator {
	if (keyByTestid(desc.testid)) {
		return scope.locator(`[data-testid="${desc.testid}"]`).nth(desc.occurrence);
	}
	return scope
		.getByRole(desc.role as Parameters<Locator['getByRole']>[0], { name: desc.name, exact: true })
		.nth(desc.occurrence);
}

/**
 * Watches for the side effects that leave NO trace in the page: a file chooser
 * (the import screen's "Backup-Datei wählen …" calls fileInput.click() and changes nothing else
 * whatsoever), a download ("Backup exportieren"), and a new tab — a link with
 * target="_blank" (the settings foot's OpenMoji credit, [D-181]) opens one and
 * leaves the page exactly as it was.
 *
 * The lifetime is the whole point. These events arrive ASYNCHRONOUSLY, a beat
 * after locator.click() resolves, so listeners scoped to the click alone would
 * miss them and report e.g. "Backup-Datei wählen …" as dead. The watch stays open
 * across the click AND the whole verdict, and `seen()` is asked again after
 * the signature poll has given the event time to show up.
 *
 * All three are also absorbed rather than merely observed: an unanswered file
 * chooser blocks the page, and a real download would litter the run.
 */
interface SideEffectWatch {
	seen: () => boolean;
	dispose: () => void;
}

function watchSideEffects(page: Page): SideEffectWatch {
	let fired = false;
	const onDownload = (download: Download): void => {
		fired = true;
		void download.cancel().catch(() => {});
	};
	const onFileChooser = (chooser: FileChooser): void => {
		fired = true;
		void chooser.setFiles([]).catch(() => {});
	};
	// Closed at once: the walk judges that a tab opened, not what it loads (an
	// external site, which CI may not even reach).
	const onPopup = (popup: Page): void => {
		fired = true;
		void popup.close().catch(() => {});
	};
	page.on('download', onDownload);
	page.on('filechooser', onFileChooser);
	page.on('popup', onPopup);
	return {
		seen: () => fired,
		dispose: () => {
			page.off('download', onDownload);
			page.off('filechooser', onFileChooser);
			page.off('popup', onPopup);
		}
	};
}

/**
 * Leaves the page with NOTHING open and nothing swallowing clicks, closing
 * what it finds rather than only waiting for it.
 *
 * The walk does not reload between controls (see reachSurface), so two kinds
 * of leftover can outlive one control:
 *
 *   1. bits-ui parks `pointer-events: none` on the document while a
 *      sheet is open and clears it on an ANIMATED close, so for a few frames
 *      after Escape the page looks idle while `<html>` still swallows every
 *      click.
 *   2. A control that OPENS something can be the last one walked on its
 *      surface — and a dropdown is `role="menu"`, not a dialog. An open menu
 *      leaves the next establish() clicking a trigger that is already
 *      `aria-expanded="true"`, which bits-ui's dismiss layer blocks; Playwright
 *      reports that as "<html …> intercepts pointer events", which reads like
 *      a stray overlay and really means "this menu is already open".
 *
 * Hence: press Escape until the page is actually clear, bounded. Checking
 * without closing is not enough, because the walk's own Escape goes to the
 * FOCUSED element and a surface may be left with focus somewhere that does not
 * dismiss the thing that is open.
 */
async function settleOverlays(page: Page): Promise<void> {
	await expect(async () => {
		const clear = await page.evaluate(() => {
			const blocked = (el: Element | null): boolean =>
				el !== null && getComputedStyle(el).pointerEvents === 'none';
			if (blocked(document.documentElement) || blocked(document.body)) return false;
			// role=menu covers the dropdowns, dialog/alertdialog the sheets and
			// confirms, and an expanded popup trigger catches anything whose
			// surface markup this list has not learned about yet.
			return (
				document.querySelector(
					'[role="menu"], [role="dialog"], [role="alertdialog"], ' +
						'[aria-haspopup][aria-expanded="true"]'
				) === null
			);
		});
		if (clear) return;
		await page.keyboard.press('Escape').catch(() => {});
		throw new Error('overlays never cleared — something is open that Escape does not dismiss');
	}).toPass({ intervals: [150], timeout: 3_000 });
}

/**
 * Re-opens the shop view's "Erledigt" section if a walked control closed it.
 *
 * `doneOpen` is component-local state in DoneItems.svelte ($state(true), not
 * persisted) and the section's own header is one of this surface's controls —
 * so the walk collapses it on the way past, `hidden={!doneOpen}` takes every
 * done-row with it, and every LATER done-row control would then be "missing on
 * re-establish" — nothing remounts the component between controls. A
 * surface's establish() owns
 * putting back the shape its enumeration was taken from; this is that, for the
 * one surface in the app with a collapsible section.
 */
export async function expandDoneSection(page: Page): Promise<void> {
	const head = page.getByTestId('done-head');
	if ((await head.count()) === 0) return;
	if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
}

/** Waits until page.url() stops changing (bounded). */
async function waitForUrlStable(page: Page): Promise<void> {
	let last = page.url();
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(150);
		const now = page.url();
		if (now === last) return;
		last = now;
	}
}

/**
 * Puts the browser back on `path`, and does nothing at all when it is already
 * there.
 *
 * That "nothing at all" keeps the walk cheap: a page.goto() is a full SPA boot
 * (Dexie open, auth refresh, digest probe, snapshot) worth a dozen-odd API
 * calls, and a boot per control would push the run past PocketBase's default
 * per-IP budget (/api/, 300/10s; arch.config.ts). Most controls open an
 * overlay rather than navigate, and for those settleOverlays() alone restores
 * the surface.
 *
 * A control that DID navigate is brought back with a plain goto to the
 * surface's own path, whatever history the control left behind.
 */
export async function reachSurface(page: Page, path: string): Promise<void> {
	// A control clicked a moment ago can still have a CLIENT-SIDE navigation in
	// flight: `observedChange` is satisfied by the DOM change such a click makes
	// and returns before SvelteKit has swapped the route, so page.url() can
	// still read the OLD location and the pending navigation would land
	// underneath the caller's readiness probe. Let the URL stop moving first.
	await waitForUrlStable(page);
	if (new URL(page.url()).pathname === path) return;
	await page.goto(path);
	// Bounded, and it ASSERTS arrival. A control clicked at the end of the
	// previous iteration can still have a client-side navigation in flight, so
	// landing is worth confirming rather than assuming — and confirming it here
	// means a drift fails fast, at this line, instead of further down inside
	// whatever establish() does next.
	await expect(page, `reachSurface: never landed on ${path}`).toHaveURL(
		new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
		{ timeout: 15_000 }
	);
}

type Kind = 'menu' | 'tab' | 'stateful' | 'plain';

/** How each kind of control was judged, for the DEAD message. */
const JUDGED: Record<Kind, string> = {
	menu: 'against its menu closed with nothing picked',
	tab: 'on what its panels hold, which bits-ui shows and hides on any click',
	stateful: 'outside its own group, which bits-ui updates on any click',
	plain: 'on the whole page'
};

/**
 * Tags the control (`data-dead-walk`) and says how its click is judged: a
 * menu item against its menu shut, a tab with panels on what they hold
 * (tagged `data-dead-walk-panel`), a radio, checkbox, switch or panel-less
 * tab on what changed outside its group (tagged `data-dead-walk-group`),
 * anything else on the whole page.
 */
async function tagControl(locator: Locator): Promise<Kind> {
	return locator.evaluate(
		(el) => {
			for (const tag of ['data-dead-walk-group', 'data-dead-walk-panel']) {
				document.querySelectorAll(`[${tag}]`).forEach((t) => t.removeAttribute(tag));
			}
			el.setAttribute('data-dead-walk', '');
			if (el.closest('[role="menu"]')) return 'menu';
			const role = el.getAttribute('role');
			if (role === 'radio' || role === 'tab') {
				const group = el.closest('[role="radiogroup"], [role="tablist"]') ?? el;
				group.setAttribute('data-dead-walk-group', '');
				let panels = 0;
				for (const tab of Array.from(group.querySelectorAll('[role="tab"][aria-controls]'))) {
					const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
					if (panel) {
						panel.setAttribute('data-dead-walk-panel', '');
						panels++;
					}
				}
				return panels > 0 ? 'tab' : 'stateful';
			}
			if (role === 'checkbox' || role === 'switch') {
				el.setAttribute('data-dead-walk-group', '');
				return 'stateful';
			}
			return 'plain';
		},
		undefined,
		{ timeout: 5_000 }
	);
}

/**
 * Walks every enumerable control of one surface: establish() once to build
 * the control list, then re-establish() before EVERY single click so one
 * control's effect can never leak into the next one's baseline.
 */
export async function walkSurface(
	page: Page,
	surface: string,
	establish: () => Promise<Locator>,
	extraSkipNames: Set<string> = new Set()
): Promise<void> {
	// The previous surface's last walked control may have left a sheet closing;
	// establish() is about to click, so wait the page out first.
	await settleOverlays(page);
	const initialScope = await establish();
	const found = withOccurrence(await enumerateControls(initialScope)).filter(
		(c) =>
			c.name.length > 0 &&
			!NEVER_CLICK_NAMES.has(c.name) &&
			!extraSkipNames.has(c.name) &&
			!(c.testid && NEVER_CLICK_TESTIDS.has(c.testid)) &&
			// One representative per same-key group, not every repeat: walking
			// EVERY category row's identically-named "hide" button (say) would
			// hide one row per iteration, and since the set of rows is exactly
			// what the key's occurrence count was measured against, later
			// occurrences run out of rows to relocate to long before their
			// turn comes up. One click per same (testid|role,name) group is
			// enough to catch a dead one — the component instance is the same
			// control repeated, not a different control each time.
			c.occurrence === 0
	);
	expect(
		found.length,
		`${surface}: enumeration found nothing to walk — selector/scope wrong?`
	).toBeGreaterThan(0);

	let previous = 'establishing the surface';
	for (const desc of found) {
		// BEFORE establish(), every iteration — not only after the click. The
		// enumeration pass above ran establish() too, and for a menu/sheet
		// surface that LEAVES IT OPEN; without this the loop's first
		// establish() clicks a trigger that is still aria-expanded, which
		// bits-ui blocks. Closing at the end of an iteration cannot cover
		// that, because the leftover is from before the loop.
		await settleOverlays(page);
		await expectOverlaysLeftWhole(page, surface, previous);
		previous = `"${desc.name}" (${desc.role})`;
		await page
			.evaluate(() =>
				document
					.querySelectorAll('[data-dead-walk]')
					.forEach((el) => el.removeAttribute('data-dead-walk'))
			)
			.catch(() => {});
		const scope = await establish();
		const locator = locateControl(scope, desc);
		await expect(
			locator,
			`${surface}: "${desc.name}" (${desc.role}) missing on re-establish`
		).toBeVisible({ timeout: 10_000 });

		// Tag the control so restHash() can subtract it if the click removes it,
		// and a stateful one's group. Cleared at the top of every iteration, so
		// a tag never outlives its turn.
		const kind = await tagControl(locator);
		let target = locator;
		let closed: Signature | null = null;
		if (kind === 'menu') {
			// The baseline a menu item is judged against: its menu shut, nothing
			// picked. Then the menu is opened again for the click.
			await page.keyboard.press('Escape');
			await settleOverlays(page);
			// The pointer parked where it is after the click too, so a hover
			// under it is never the difference.
			await page.mouse.move(0, 0);
			closed = await stableSignature(page);
			target = locateControl(await establish(), desc);
			await expect(target, `${surface}: "${desc.name}" missing on reopening`).toBeVisible({
				timeout: 10_000
			});
			await tagControl(target);
		}
		// A menu item's baseline is `closed`; any other control's is taken now.
		const before = closed ? null : await stableSignature(page);
		const beforeRest = closed ? null : await contentHash(page, kind);
		const effects = watchSideEffects(page);
		try {
			await target.click({ timeout: 10_000 });
			if (closed) await page.mouse.move(0, 0);
			// Ordered cheapest-and-safest first, and `effects.seen()` is asked
			// once more at the end because a file chooser / download surfaces a
			// beat after the click — by then the signature poll has waited.
			let observable = effects.seen();
			if (!observable && closed) observable = await observedAfterMenu(page, closed);
			if (!observable && before && beforeRest !== null) {
				observable = await observedChange(page, before, beforeRest, kind);
			}
			// Focus is the last resort and only worth asking while the control is
			// still there to ask about (see focusMovedAway).
			if (!observable && (await page.locator('[data-dead-walk]').count()) > 0) {
				observable = await focusMovedAway(target);
			}
			observable = observable || effects.seen();
			expect(
				observable,
				`${surface}: "${desc.name}" (${desc.role}) is a DEAD CONTROL — nothing ` +
					`observable changed after clicking it (no URL, DOM, focus, toast, download, ` +
					`new tab, file-chooser or clipboard/share effect; judged ${JUDGED[kind]})`
			).toBe(true);
		} finally {
			effects.dispose();
		}
		// The start-of-iteration settleOverlays() is what guarantees a clear
		// page; this Escape just gets the common case out of the way cheaply.
		await settleEntrances(page);
		await page.keyboard.press('Escape').catch(() => {});
	}
	await settleOverlays(page);
	await expectOverlaysLeftWhole(page, surface, previous);
}
