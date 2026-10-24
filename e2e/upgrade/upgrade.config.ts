import { defineConfig, devices } from '@playwright/test';
import { basePort, LOCALE } from '../server';

// The upgrade harness: a device and a database of the previous release are
// updated to this build, and nothing either was holding is lost.
//
// No webServer: the spec stops the previous release's server and starts this
// build's on the same port and data, as a deploy does, and Playwright starts
// every webServer before the first test and stops it after the last.
//
// Run it as `scripts/gate.sh e2e:upgrade`, which builds both binaries first;
// by hand, from e2e/ after `task build-app prev-release`:
//   E2E_PORT=8085 E2E_PREVIOUS_DIR=~/.cache/shoppinglist-prev/<tag> npx playwright test -c upgrade/upgrade.config.ts
const PORT = basePort('8085');

export default defineConfig({
	testDir: './',
	outputDir: 'test-results',
	workers: 1,
	// Same ceilings as the functional suite (playwright.config.ts).
	expect: { timeout: 30_000 },
	timeout: 180_000,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${PORT}`,
		locale: LOCALE,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'upgrade-chromium', use: { ...devices['Desktop Chrome'] } }]
});
