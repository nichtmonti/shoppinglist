import { expect, test } from './fixtures';
import { registerAccount } from './helpers';

// [D-344] A newer build in another tab upgrades the device's database: this
// tab reloads into that build rather than reopening the upgraded database
// under its own older schema.

test('a tab reloads when another tab upgrades the database', async ({ page, context }) => {
	await registerAccount(page, 'Ute');
	// Same origin, no app on it: its own connection would reload it too.
	const other = await context.newPage();
	await other.goto('/api/health');

	const reloaded = page.waitForEvent('load', { timeout: 15_000 });
	// What the newer build's first open does: the same database at a higher version.
	await other.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const probe = indexedDB.open('einkaufsliste_sync');
				probe.onsuccess = () => {
					const version = probe.result.version;
					probe.result.close();
					const upgrade = indexedDB.open('einkaufsliste_sync', version + 10);
					upgrade.onsuccess = () => {
						upgrade.result.close();
						resolve();
					};
					upgrade.onerror = () => reject(upgrade.error ?? new Error('upgrade failed'));
				};
				probe.onerror = () => reject(probe.error ?? new Error('no database'));
			})
	);
	await reloaded;
	await expect(page.getByText('Willkommen!')).toBeVisible();
});
