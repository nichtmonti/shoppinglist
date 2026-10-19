import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { appServer, basePort, LOCALE } from '../server';

// The demo build's harness ([D-234]): a visitor's way in, the example list,
// a second visitor joining through an invite, sign-out and an expired demo,
// in a real browser against the demo binary (scripts/build-demo.sh).
//
// Its own run because it is its own binary: a demo instance has passkeys and
// OIDC off and a different auth screen, which no other harness expects. A
// fresh database each run, one worker.
//
// Run it as `scripts/gate.sh e2e:demo`, which builds the demo binary first;
// by hand, from e2e/ after scripts/build-demo.sh:
//   E2E_PORT=8088 npx playwright test -c demo/demo.config.ts
const PORT = basePort('8088');
const REPO = resolve(import.meta.dirname, '../..');

// CI and the gate build it and say where; by hand it is build-demo.sh's output.
const BIN = process.env.SHOPPINGLIST_DEMO_BIN ?? 'backend/shoppinglist-demo';
if (!existsSync(resolve(REPO, BIN))) {
	throw new Error(`demo.config.ts: no demo binary at ${BIN} — run scripts/build-demo.sh first`);
}

export default defineConfig({
	testDir: './',
	// Its own, beside this config: the lanes run harnesses side by side (Taskfile e2e:browsers).
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
		}
	]
});
