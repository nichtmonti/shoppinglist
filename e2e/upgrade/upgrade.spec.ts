import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { appServer } from '../server';
import {
	addItemByTyping,
	appearsAfter,
	createList,
	disableConditionalMediation,
	expectSynced,
	itemRow,
	nicknameField,
	openListView,
	openSameAccountDevice,
	registerAccount,
	storeCount
} from '../tests/helpers';
import { expect, test, type Page } from '../tests/fixtures';

// A household on the previous release, its server updated to this build while
// a phone holds edits it has not sent: an edit made while the server is down
// for the update, sent by the page still running the previous build, and
// edits still waiting when the phone loads the new build. Every one arrives,
// the database the previous release wrote is this build's, a backup it saved
// restores, and its passkey still signs in.

const PREVIOUS = process.env.E2E_PREVIOUS_BIN;
const CURRENT = process.env.SHOPPINGLIST_BIN ?? 'backend/shoppinglist';

/** One app server on `port`, from appServer's command and environment, up
 *  once it answers its health check. */
async function startServer(port: string, bin: string, fresh: boolean): Promise<ChildProcess> {
	const spec = appServer(port, {
		SHOPPINGLIST_BIN: bin,
		...(fresh ? { E2E_FRESH_DATA: '1' } : {})
	});
	const server = spawn('sh', ['-c', spec.command], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		// As Playwright's webServer: the log only, not PocketBase's request lines.
		stdio: ['ignore', 'ignore', 'inherit']
	});
	const health = () =>
		fetch(spec.url)
			.then((r) => r.status)
			.catch(() => 0);
	// A server that refuses to start says why on stderr, above this failure.
	const early = once(server, 'exit').then(([code]) => `${bin} exited (${code}) before it answered`);
	const up = expect.poll(health, { timeout: 60_000 }).toBe(200);
	const failure = await Promise.race([up.then(() => undefined), early]);
	if (failure) throw new Error(failure);
	return server;
}

/** Stops it as a deploy does, and waits until it has exited. */
async function stopServer(server: ChildProcess): Promise<void> {
	if (server.exitCode !== null || server.signalCode !== null) return;
	const exited = once(server, 'exit');
	server.kill('SIGTERM');
	await exited;
}

/** The build the page runs: SvelteKit names its global after the build's version. */
function buildOf(page: Page): Promise<string | undefined> {
	return page.evaluate(() => Object.keys(window).find((key) => key.startsWith('__sveltekit_')));
}

test('an update loses nothing a device or the server was holding', async ({
	page,
	browser,
	baseURL
}) => {
	expect(PREVIOUS, 'E2E_PREVIOUS_BIN names the previous release (task prev-release)').toBeTruthy();
	const port = new URL(baseURL!).port;
	let server = await startServer(port, resolve(PREVIOUS!), true);
	try {
		await registerAccount(page, 'Ute');
		await createList(page, 'Vorrat');
		await openListView(page);
		await addItemByTyping(page, 'Milch');
		await addItemByTyping(page, 'Brot');
		await expectSynced(page);
		const previousBuild = await buildOf(page);

		// A backup saved on the previous release ([D-72]).
		await page.getByRole('button', { name: 'Zurück' }).click();
		await page.getByRole('button', { name: 'Aktionen für Vorrat', exact: true }).click();
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('menuitem', { name: 'Backup exportieren' }).click()
		]);
		const backup = test.info().outputPath(download.suggestedFilename());
		await download.saveAs(backup);
		await page.getByRole('link', { name: 'Vorrat öffnen' }).click();
		await openListView(page);

		// The server is down for the update: the edit waits in the outbox.
		await stopServer(server);
		await addItemByTyping(page, 'Eier');
		expect(await storeCount(page, 'pending_ops')).toBeGreaterThan(0);

		// This build's server takes over the previous release's database, and
		// the page still running the previous build sends what it held.
		server = await startServer(port, CURRENT, false);
		await expectSynced(page);

		// Edits the server does not get before the phone loads the new build.
		await page.route('**/api/sync/push', (route) => route.abort());
		await addItemByTyping(page, 'Butter');
		const brot = itemRow(page, 'Brot');
		await brot.getByRole('button', { name: 'Menge hinzufügen' }).click();
		const quantity = brot.getByRole('textbox', { name: 'Menge bearbeiten' });
		await quantity.fill('2');
		await quantity.press('Enter');
		await expect(brot.getByRole('button', { name: 'Menge bearbeiten' })).toContainText('2');
		await expect.poll(() => storeCount(page, 'pending_ops')).toBe(2);

		await page.reload();
		await expect(itemRow(page, 'Butter')).toBeVisible();
		expect(await buildOf(page), 'the reload loaded this build').not.toBe(previousBuild);
		expect(await storeCount(page, 'pending_ops'), 'the new build kept the outbox').toBe(2);
		await page.unroute('**/api/sync/push');
		await expectSynced(page);

		// What the server has, on a device that never ran the previous build.
		const other = await openSameAccountDevice(browser, page);
		await other.page.getByRole('link', { name: 'Vorrat öffnen' }).click();
		await openListView(other.page);
		for (const name of ['Milch', 'Eier', 'Butter']) {
			await expect(itemRow(other.page, name)).toBeVisible();
		}
		await expect(
			itemRow(other.page, 'Brot').getByRole('button', { name: 'Menge bearbeiten' })
		).toContainText('2');

		// The previous release's backup restores on this one.
		await other.page.getByRole('button', { name: 'Zurück' }).click();
		await other.page.getByRole('button', { name: 'Liste importieren' }).click();
		await other.page.locator('input[type="file"]').setInputFiles(backup);
		await expect(other.page).toHaveURL(/\/list\/[^/]+$/);
		await openListView(other.page);
		for (const name of ['Milch', 'Brot']) {
			await expect(itemRow(other.page, name)).toBeVisible();
		}
		await other.context.close();

		// The passkey the previous release registered signs in on this one (to the
		// home with both lists, the original and its restored copy).
		await disableConditionalMediation(page, { acrossNavigations: true });
		await page.goto('/settings');
		await appearsAfter(nicknameField(page), () =>
			page.getByRole('button', { name: 'Auf diesem Gerät abmelden' }).click()
		);
		await appearsAfter(page.getByRole('link', { name: 'Vorrat öffnen' }).first(), () =>
			page.getByRole('button', { name: 'Mit Passkey anmelden' }).click()
		);
	} finally {
		await stopServer(server);
	}
});
