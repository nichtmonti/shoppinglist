import { expect, test } from './fixtures';
import { createList, disableConditionalMediation, registerAccount } from './helpers';

// [D-182]: signing in starts from an empty local mirror (sign-out wipes it).
// Until the first sync cycle's digest answers, the home shows a loading state —
// never the brand-new-account welcome, whose create/join would invite a
// returning user to recreate lists they already have. The digest is held here
// so the window is deterministic instead of a race.
test('a returning account sees its lists loading, never the welcome, after signing in', async ({
	page
}) => {
	await registerAccount(page, 'Rueckkehr');
	await createList(page, 'Wocheneinkauf');

	// Otherwise the virtual authenticator signs the page straight back in after
	// the sign-out; this test signs in by button instead.
	await disableConditionalMediation(page, { acrossNavigations: true });
	await page.goto('/settings');
	await page.getByRole('button', { name: 'Auf diesem Gerät abmelden' }).click();
	await expect(page.getByLabel('Spitzname', { exact: true })).toBeVisible();
	// [D-185]: the sign-out itself lands on the home, so the next sign-in does
	// not render /settings first.
	await expect(page).toHaveURL(/\/$/);

	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/sync/digest', async (route) => {
		await held;
		await route.continue();
	});

	await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();

	await expect(page.getByTestId('home-loading')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText('Deine Listen werden geladen …')).toBeVisible();
	await expect(page.getByText('Willkommen!')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Neue Liste' })).toHaveCount(0);

	release();

	await expect(page.getByRole('link', { name: 'Wocheneinkauf öffnen' })).toBeVisible({
		timeout: 15_000
	});
	await expect(page.getByTestId('home-loading')).toHaveCount(0);
	await expect(page.getByText('Willkommen!')).toHaveCount(0);
});
