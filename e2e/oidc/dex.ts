import { expect, test, type Page } from '../tests/fixtures';
import { disableConditionalMediation, readAuthBlob } from '../tests/helpers';

// The Dex round trips both OIDC specs share (oidc.spec.ts, and the
// passkeys-off instance's oidc-only.spec.ts, [D-76]).

// Each journey requests from its own client IP, as every test does
// (tests/fixtures.ts), and each OIDC exchange within it from a further one.
// PocketBase allows 2 auth exchanges per 3s per IP, and a journey that signs
// in, links and signs in again can make three within that window on a fast
// run. Only the exchange request is re-addressed: the popup's navigation and
// every other request keep the journey's IP (re-addressing the whole context
// mid-popup breaks the popup).
let exchange = 0;
/** Gives each OIDC exchange its own client IP; call once at a spec's top level. */
export function ownClientIpPerExchange(offset = 0): void {
	test.beforeEach(async ({ context }) => {
		await context.route('**/api/collections/accounts/auth-with-oauth2', (route) => {
			exchange += 1;
			return route.continue({
				headers: {
					...route.request().headers(),
					'x-forwarded-for': `10.1.${offset}.${exchange % 250}`
				}
			});
		});
	});
}

/**
 * Presses the auth screen's "Weiter mit Dex" and signs in as `name` in the
 * provider popup — the round trip PocketBase completes over its @oauth2 SSE
 * topic, which is exactly the hop the Go flow tests cannot take.
 */
export async function signInWithDex(page: Page, name: string): Promise<void> {
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Weiter mit Dex' }).click();
	await loginAtDex(await popup, name);
}

/** Dex's login form, as oidc.config.ts configures its users. */
export async function loginAtDex(popup: Page, name: string): Promise<void> {
	await popup.getByLabel('Email Address').fill(`${name.toLowerCase()}@example.com`);
	await popup.getByLabel('Password').fill('password');
	await popup.getByRole('button', { name: 'Login' }).click();
	// The popup closes itself once PocketBase has pushed the code to the page.
	await popup.waitForEvent('close');
}

/**
 * Signs out on this device from settings. Conditional mediation is switched
 * off first: CDP's virtual authenticator would otherwise answer the auth
 * screen's passkey autofill on its own and sign straight back in.
 */
export async function signOut(page: Page): Promise<void> {
	await page.goto('/settings');
	await disableConditionalMediation(page);
	await page.getByRole('button', { name: 'Auf diesem Gerät abmelden' }).click();
	// The auth screen: an instance without passkeys ([D-76]) has no nickname
	// field, but every instance with OIDC on offers the provider.
	await expect(page.getByRole('button', { name: 'Weiter mit Dex' })).toBeVisible();
}

/**
 * The lists home, after a sign-in that happened on another route. Waits for
 * the sign-in to be stored first: navigating mid-sign-in would abort it. The
 * Dex button going is no sign of that, as it reads "Abbrechen" while the
 * exchange is still pending.
 */
export async function home(page: Page): Promise<void> {
	await expect.poll(() => readAuthBlob(page), { timeout: 15_000 }).not.toBe('');
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Neue Liste' }).first()).toBeVisible();
}

export async function nicknameInSettings(page: Page): Promise<string> {
	await page.goto('/settings');
	const shown = page.getByTestId('settings-nickname');
	await expect(shown).not.toHaveText('');
	return (await shown.textContent())?.trim() ?? '';
}
