import { expect, test } from './fixtures';
import {
	createList,
	disableConditionalMediation,
	registerAccount,
	storeCount,
	tapSyncConsole
} from './helpers';

// §5.6 [D-55]/[D-109]: signing out in one tab ends the session in every
// other tab of the same browser. logout() clears the in-memory auth and wipes
// the local mirror, and a BroadcastChannel tells the other tabs; without it a
// second tab would keep its still-valid token in memory, keep rendering the
// signed-in app, and on its next sync cycle repopulate the shared tables the
// wipe just emptied.
//
// This is local session/cache isolation, not server authorization — the other
// tab's token is genuinely valid. logout-everywhere.spec.ts covers the other
// half, §5.6 [D-04] token rotation across devices.

test('signing out in one tab ends the session in the other', async ({ page, context }) => {
	tapSyncConsole(page, 'tab-a');
	await registerAccount(page, 'AuditTab');
	await createList(page, 'Private audit household');

	const other = await context.newPage();
	tapSyncConsole(other, 'tab-b');
	await other.clock.install();
	await other.goto('/settings');
	await expect(other.getByRole('button', { name: 'Auf diesem Gerät abmelden' })).toBeVisible();

	await page.goto('/settings');
	// Otherwise the virtual authenticator signs the tab straight back in, which
	// reads as "logout is broken" rather than "the harness logged back in".
	await disableConditionalMediation(page);
	await page.getByRole('button', { name: 'Auf diesem Gerät abmelden' }).click();
	await expect(page.getByLabel('Spitzname', { exact: true })).toBeVisible();

	// No reload of `other`: auth lives in memory PER TAB, so a reload would read
	// the (correctly) cleared token and prove nothing about propagation. The
	// BroadcastChannel is what has to reach this tab.
	await expect(other.getByLabel('Spitzname', { exact: true })).toBeVisible();
	await expect(other.getByRole('button', { name: 'Auf diesem Gerät abmelden' })).toHaveCount(0);

	// And it stays wiped: startSyncLoop suppresses focus triggers for
	// MIN_RETRIGGER_MS (3s, on Date.now) after a completed cycle, so a cycle
	// that could repopulate the tables can only start after that cooldown —
	// hence the clock moved past it before the focus event.
	await other.clock.fastForward(3500);
	await other.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => storeCount(other, 'memberships'), { timeout: 10_000 }).toBe(0);
});

// [D-109] The tabs share the stored token and the local mirror, so a browser
// profile holds one account at a time: a sign-in in one tab brings every other
// tab to that account, here one left on the sign-in screen by the sign-out.
test('signing in in one tab brings the other tab to that account', async ({ page, context }) => {
	await registerAccount(page, 'Erste');
	const other = await context.newPage();
	await other.goto('/');
	await expect(other.getByText('Willkommen!')).toBeVisible();

	await page.goto('/settings');
	await disableConditionalMediation(page);
	await page.getByRole('button', { name: 'Auf diesem Gerät abmelden' }).click();
	await expect(other.getByLabel('Spitzname', { exact: true })).toBeVisible();

	await page.getByLabel('Spitzname', { exact: true }).fill('Zweite');
	await page.getByRole('button', { name: 'Konto erstellen' }).click();
	await expect(page.getByText('Willkommen!')).toBeVisible({ timeout: 15_000 });

	await expect(other.getByText('Willkommen!')).toBeVisible({ timeout: 15_000 });
	await other.goto('/settings');
	await expect(other.getByTestId('settings-nickname')).toContainText('Zweite');
});
