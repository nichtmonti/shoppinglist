import { defineConfig, devices } from '@playwright/test';
import { appServer as baseAppServer, basePort, LOCALE } from '../server';
import { dexServer } from './dex-server';

// OIDC harness config (§5.9, [D-76], [D-25], [D-154]): the sign-in, link and
// passkey-on-an-OIDC-account journeys in a real browser, against Dex — the
// OpenID Connect provider pinned in tools/dex, the same one the Go tests
// (backend/internal/dextest) run. The Go tests drive the server flow
// headlessly and skip the two hops only a browser performs: the popup's
// redirect to /api/oauth2-redirect and PocketBase's @oauth2 SSE push back to
// the page — plus the settings UI around them.
//
// WHY ITS OWN RUN: an instance with OIDC configured renders an extra button
// on the auth screen, which the functional suite's visual gate would see as a
// regression. So this is a second server with the OIDC env, on its own port,
// with an empty database each run (E2E_FRESH_DATA — Dex's users are fixed,
// and one that signed in on the last run would land on that run's account).
// One worker: the specs share those users.
//
// A SECOND app server runs with SHOPPINGLIST_PASSKEYS=off ([D-76]) on its
// own port, for the OIDC-only instance's journeys (oidc-only.spec.ts, its own
// project below); both sign in against the one Dex.
//
// Run it as `scripts/gate.sh e2e:oidc`; by hand, from e2e/:
//   E2E_PORT=8095 npx playwright test -c oidc/oidc.config.ts
const PORT = basePort('8095');
const ONLY_PORT = process.env.E2E_OIDC_ONLY_PORT ?? '8094';
const DEX_PORT = process.env.E2E_DEX_PORT ?? '5557';
// One user per journey, so no spec depends on another having run. The spec
// signs in as `<name lowercased>@example.com`, password "password".
const USERS = ['Anna', 'Bob', 'Cleo', 'Dora', 'Emil', 'Finn', 'Gina', 'Hanna', 'Ida', 'Jana'];
const DEX = dexServer(
	DEX_PORT,
	[`http://localhost:${PORT}`, `http://localhost:${ONLY_PORT}`],
	USERS
);
const ISSUER = DEX.issuer;

/** One app server: the journeys' env, plus `extra` for the variant. */
function appServer(port: string, extra: Record<string, string>) {
	return baseAppServer(port, {
		E2E_FRESH_DATA: '1',
		// Discovery: the server reads the three endpoints from Dex's
		// .well-known document at boot. The OIDC-only server below sets
		// them by hand instead, so both configurations are exercised.
		...DEX.appEnv,
		...extra
	});
}

export default defineConfig({
	testDir: './',
	// Its own, beside this config: lanes run harnesses side by side (Taskfile e2e:lanes).
	outputDir: 'test-results',
	workers: 1,
	// Same ceilings as the functional suite (playwright.config.ts).
	expect: { timeout: 30_000 },
	timeout: 120_000,
	retries: 0,
	reporter: [['list']],
	webServer: [
		DEX.webServer,
		appServer(PORT, {}),
		// [D-76]: an OIDC-only instance. No RP-ID: passkeys are off, and the
		// app's origin comes from SHOPPINGLIST_APP_URL.
		appServer(ONLY_PORT, {
			SHOPPINGLIST_OIDC_ISSUER: '',
			SHOPPINGLIST_OIDC_AUTH_URL: `${ISSUER}/auth`,
			SHOPPINGLIST_OIDC_TOKEN_URL: `${ISSUER}/token`,
			SHOPPINGLIST_OIDC_USERINFO_URL: `${ISSUER}/userinfo`,
			SHOPPINGLIST_PASSKEYS: 'off',
			SHOPPINGLIST_RP_ID: '',
			SHOPPINGLIST_RP_ORIGIN: '',
			SHOPPINGLIST_APP_URL: `http://localhost:${ONLY_PORT}`
		})
	],
	use: {
		locale: LOCALE,
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'oidc-chromium',
			testMatch: 'oidc.spec.ts',
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` }
		},
		{
			name: 'oidc-only-chromium',
			testMatch: 'oidc-only.spec.ts',
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${ONLY_PORT}` }
		}
	]
});
