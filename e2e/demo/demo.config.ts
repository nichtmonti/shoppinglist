import { defineConfig, devices } from '@playwright/test';
import { appServer, basePort, LOCALE } from '../server';

// The demo build's harness ([D-234]): a visitor's way in, the example list,
// a second visitor joining through an invite, sign-out and an expired demo,
// in Chromium and Firefox against the demo binary (`task build-demo`): with
// no passkey to sign in, the one harness Firefox can run on a real server
// ([D-301]).
//
// Its own run because it is its own binary: a demo instance has passkeys and
// OIDC off and a different auth screen, which no other harness expects. A
// fresh database each run, one worker.
//
// Run it as `scripts/gate.sh e2e:demo`, which builds the demo binary first;
// by hand, from e2e/ after `task build-demo`:
//   E2E_PORT=8088 npx playwright test -c demo/demo.config.ts
const PORT = basePort('8088');

// CI and the gate build it and say where; by hand it is `task build-demo`'s output.
const BIN = process.env.SHOPPINGLIST_DEMO_BIN ?? 'backend/shoppinglist-demo';

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
		appServer(PORT, {
			SHOPPINGLIST_BIN: BIN,
			E2E_FRESH_DATA: '1',
			SHOPPINGLIST_PASSKEYS: 'off',
			SHOPPINGLIST_RP_ID: '',
			SHOPPINGLIST_RP_ORIGIN: '',
			SHOPPINGLIST_APP_URL: `http://localhost:${PORT}`
		})
	],
	use: {
		locale: LOCALE,
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'demo-chromium',
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` }
		},
		{
			name: 'demo-firefox',
			use: { ...devices['Desktop Firefox'], baseURL: `http://localhost:${PORT}` }
		}
	]
});
