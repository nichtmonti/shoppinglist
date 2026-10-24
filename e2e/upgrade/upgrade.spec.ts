import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appServer } from '../server';
import {
	addVirtualAuthenticator,
	appearsAfter,
	disableConditionalMediation,
	expectSynced,
	itemRow,
	nicknameField,
	openListView,
	openSameAccountDevice,
	storeCount
} from '../tests/helpers';
import { expect, test, type Page } from '../tests/fixtures';

// A household on the previous release, its server updated to this build while
// a phone holds edits it has not sent: an edit made while the server is down
// for the update, sent by the page still running the previous build, and
// edits still waiting when the phone loads the new build. Every one arrives,
// the database the previous release wrote is this build's, a backup it saved
// restores, and its passkey still signs in.

const PREVIOUS = process.env.E2E_PREVIOUS_DIR;
const CURRENT = process.env.SHOPPINGLIST_BIN ?? 'backend/shoppinglist';

/**
 * The previous release's own German copy, by message key: until the reload,
 * the page shows what that build says, whatever this one has changed since.
 */
function previousCopy(dir: string): (key: string, params?: Record<string, string>) => string {
	const messages = JSON.parse(
		readFileSync(resolve(dir, 'frontend/messages/de.json'), 'utf8')
	) as Record<string, unknown>;
	return (key, params = {}) => {
		const message = messages[key];
		if (typeof message !== 'string') throw new Error(`the previous release has no message ${key}`);
		return message.replace(/\{(\w+)\}/g, (_, name: string) => {
			if (!(name in params)) throw new Error(`${key} needs {${name}}`);
			return params[name];
		});
	};
}

let server: ChildProcess | undefined;

/** One app server on `port`, from appServer's command and environment, up
 *  once it answers its health check. */
async function startServer(port: string, bin: string, fresh: boolean): Promise<ChildProcess> {
	const spec = appServer(port, {
		SHOPPINGLIST_BIN: bin,
		...(fresh ? { E2E_FRESH_DATA: '1' } : {})
	});
	const health = () =>
		fetch(spec.url)
			.then((r) => r.status)
			.catch(() => 0);
	// A server left over from an earlier run would answer for this one.
	expect(await health(), `port ${port} is free`).toBe(0);
	const child = spawn('sh', ['-c', spec.command], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		// As Playwright's webServer: the log only, not PocketBase's request lines.
		stdio: ['ignore', 'ignore', 'inherit']
	});
	server = child;
	// A server that refuses to start says why on stderr, above this failure.
	const early = once(child, 'exit').then(([code]) => `${bin} exited (${code}) before it answered`);
	const up = expect.poll(health, { timeout: 60_000 }).toBe(200);
	const failure = await Promise.race([up.then(() => undefined), early]);
	if (failure) throw new Error(failure);
	return child;
}

/** Stops it as a deploy does, and waits until it has exited. */
async function stopServer(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	await exited;
}

// After a failure or a timeout too, which skip the rest of the test.
test.afterEach(() => stopServer(server));

/** The build the page runs: SvelteKit names its global after the build's version. */
function buildOf(page: Page): Promise<string | undefined> {
	return page.evaluate(() => Object.keys(window).find((key) => key.startsWith('__sveltekit_')));
}

test('an update loses nothing a device or the server was holding', async ({
	page,
	browser,
	baseURL
}) => {
	expect(PREVIOUS, 'E2E_PREVIOUS_DIR names the previous release (task prev-release)').toBeTruthy();
	const said = previousCopy(PREVIOUS!);
	const port = new URL(baseURL!).port;
	const previous = await startServer(port, resolve(PREVIOUS!, 'backend/shoppinglist'), true);

	// The previous build, in its own words.
	const addItem = async (name: string) => {
		const input = page.getByRole('combobox');
		await input.fill(name);
		await input.press('Enter');
		await expect(input).toHaveValue('');
	};
	const sentAll = async () => {
		await expect.poll(() => storeCount(page, 'pending_ops').catch(() => -1)).toBe(0);
		await expect(page.getByText(said('banner_synced')).first()).toBeVisible();
	};
	await addVirtualAuthenticator(page);
	await page.goto('/');
	await page.getByRole('textbox', { name: said('auth_nickname_label'), exact: true }).fill('Ute');
	await page.getByRole('button', { name: said('auth_create_account') }).click();
	await expect(page.getByText(said('home_empty_title'))).toBeVisible();
	await page
		.getByRole('button', { name: said('home_new_list') })
		.first()
		.click();
	const dialog = page.getByRole('dialog', { name: said('home_new_list') });
	await dialog.getByLabel(said('home_new_list_prompt')).fill('Vorrat');
	await dialog.getByRole('button', { name: said('home_new_list') }).click();
	await expect(page).toHaveURL(/\/list\/[^/]+$/);
	await openListView(page);
	await addItem('Milch');
	await addItem('Brot');
	await sentAll();
	const previousBuild = await buildOf(page);

	// A backup saved on the previous release ([D-72]).
	await page.getByRole('button', { name: said('common_back') }).click();
	await page
		.getByRole('button', { name: said('common_actions_for', { name: 'Vorrat' }), exact: true })
		.click();
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('menuitem', { name: said('home_action_export') }).click()
	]);
	const backup = test.info().outputPath(download.suggestedFilename());
	await download.saveAs(backup);
	await page.getByRole('link', { name: said('home_open_list', { name: 'Vorrat' }) }).click();
	await openListView(page);

	// The server is down for the update: the edit waits in the outbox.
	await stopServer(previous);
	await addItem('Eier');
	expect(await storeCount(page, 'pending_ops')).toBeGreaterThan(0);

	// This build's server takes over the previous release's database, and
	// the page still running the previous build sends what it held.
	await startServer(port, CURRENT, false);
	await sentAll();

	// Edits the server does not get before the phone loads the new build.
	await page.route('**/api/sync/push', (route) => route.abort());
	await addItem('Butter');
	const brot = itemRow(page, 'Brot');
	await brot
		.getByRole('button', { name: said('list_add_quantity_named', { name: 'Brot' }) })
		.click();
	const quantity = brot.getByRole('textbox', { name: said('list_edit_quantity') });
	await quantity.fill('2');
	await quantity.press('Enter');
	await expect(brot.getByRole('button', { name: said('list_edit_quantity') })).toContainText('2');
	await expect.poll(() => storeCount(page, 'pending_ops')).toBe(2);

	// This build, from here on.
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
});
