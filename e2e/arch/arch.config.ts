import { defineConfig, devices } from '@playwright/test';
import { appServer, basePort, LOCALE } from '../server';

// Architectural-gate harness (§9.1, [D-124]): dead-controls.spec.ts presses
// every visible, enabled control on every surface and fails unless something
// observable changes. Separate from the functional suite (tests/).
//
// WHY ITS OWN RUN: the walk registers accounts, creates lists and boots the
// SPA far more often than a product spec. Beside the functional suite's
// parallel workers its requests exceed PocketBase's default per-IP `/api/`
// rule (300/10s) — PocketBase's own limit, not one of the app's per-route
// budgets, which each test escapes by arriving from its own address
// (tests/fixtures.ts, [D-223]) — and the
// resulting 429s fail whichever spec asks next. So: one worker, its own server
// and port, nothing else competing, rather than a looser limit in production.
//
// Run it as `scripts/gate.sh e2e:arch`; by hand, from e2e/:
//   E2E_PORT=8096 npx playwright test -c arch/arch.config.ts
const PORT = basePort('8096');

export default defineConfig({
	testDir: './',
	// Its own, beside this config: a run never empties another harness's traces.
	outputDir: 'test-results',
	// One worker is load-bearing: the parallel burst is why this config exists.
	workers: 1,
	// The walk re-establishes its surface before every control on a screen, so a
	// single surface is long by design; these are ceilings, not floors.
	timeout: 300_000,
	expect: { timeout: 30_000 },
	// A dead control is deterministic — it does nothing every time — so a retry
	// would only hide a flake in the walk itself.
	retries: 0,
	reporter: [['list']],
	webServer: appServer(PORT),
	use: {
		baseURL: `http://localhost:${PORT}`,
		// The walk relocates controls by their German accessible names.
		locale: LOCALE
	},
	projects: [{ name: 'arch-chromium', use: { ...devices['Desktop Chrome'] } }]
});
