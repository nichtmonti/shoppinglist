import { expect, test } from './fixtures';
import { addVirtualAuthenticator } from './helpers';

test('passkey register then reload keeps the session', async ({ page }) => {
	await addVirtualAuthenticator(page);
	// Relative, so this follows the config's baseURL — which is also the origin
	// the passkey ceremony is signed against (an absolute URL here would send
	// the spec to whatever else happens to be on the default port).
	await page.goto('/');

	// Register a new anonymous account via the virtual authenticator. A fresh
	// account has zero memberships, so successful auth lands on the §9.3
	// cold-start empty state rather than any auth-screen copy.
	const nick = `Tester${Math.random().toString(36).slice(2, 6)}`;
	await page.getByLabel('Spitzname', { exact: true }).fill(nick);
	await page.getByRole('button', { name: 'Konto erstellen' }).click();
	await expect(page.getByText('Willkommen!')).toBeVisible({
		timeout: 15_000
	});

	// Reload — the token persists in IndexedDB and the session stays
	// authenticated (§5.6 sliding-window refresh, no new ceremony needed).
	await page.reload();
	await expect(page.getByText('Willkommen!')).toBeVisible({
		timeout: 15_000
	});
});
