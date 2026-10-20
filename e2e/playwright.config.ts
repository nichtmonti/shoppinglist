import { defineConfig, devices } from '@playwright/test';
import { appServer, basePort, inviteOnlyServer, LOCALE } from './server';

// The functional E2E suite (docs/internals/design.md §14 layer 4). Chromium only: the passkey
// ceremonies use Chromium's CDP virtual authenticator (tests/helpers.ts).
// WebKit/iOS installed-PWA ceremonies remain manual device tests (§5.7).
const PORT = basePort('8097');
const INVITE = inviteOnlyServer();

export default defineConfig({
	testDir: './tests',
	retries: 0,
	// Sync-settle and second-device assertions need far more than Playwright's
	// 5s/30s defaults on a slow CI runner. These are ceilings, not floors —
	// passing assertions still resolve immediately.
	expect: { timeout: 30_000 },
	timeout: 120_000,
	webServer: [
		appServer(PORT, { E2E_SUPERUSER: '1' }, { reuseExisting: !process.env.CI }),
		// [D-241] invite-signup.spec.ts's instance: invite-only, an empty
		// database every run (its setup link admits only the first account),
		// and its log in a file the spec reads the link from.
		appServer(INVITE.port, {
			SHOPPINGLIST_SIGNUP: 'invite',
			E2E_FRESH_DATA: '1',
			E2E_SERVER_LOG: INVITE.log
		})
	],
	use: {
		baseURL: `http://localhost:${PORT}`,
		locale: LOCALE,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
