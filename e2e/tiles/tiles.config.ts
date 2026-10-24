import { defineConfig, devices } from '@playwright/test';
import { basePort, viteDevServer } from '../server';

// The design gallery's audits (§9.1): tile-audit.spec.ts measures every
// shop-view tile the gallery renders and fails when a part overlaps another
// or leaves the tile ([D-166]); states-audit.spec.ts runs axe and a 44px
// touch-target sweep over every gallery state ([D-228]). Both open the
// gallery by URL through gallery.ts.
//
// WHY ITS OWN HARNESS: the gallery (/dev/gallery) is dev-only — its page
// imports the fixtures only under import.meta.env.DEV, so the built SPA the
// other harnesses serve does not contain it. This one runs the Vite dev
// server instead, and needs no backend at all. It generates into its own
// .svelte-kit-tiles and caches deps in its own node_modules/.vite-tiles
// (vite.config.ts), so it can run beside scripts/dev.sh.
//
// Run it as `scripts/gate.sh e2e:tiles`; by hand, from e2e/:
//   E2E_PORT=8093 npx playwright test -c tiles/tiles.config.ts
const PORT = basePort('8093');

export default defineConfig({
	testDir: './',
	// Its own, beside this config: a run never empties another harness's traces.
	outputDir: 'test-results',
	// A geometry fault is deterministic; a retry would only hide a settle bug
	// in the audit itself.
	retries: 0,
	workers: 2,
	// The dev server transforms the gallery's graph on the first visit.
	timeout: 180_000,
	reporter: [['list']],
	webServer: viteDevServer(PORT, 'tiles'),
	use: { baseURL: `http://127.0.0.1:${PORT}` },
	// Firefox too: every other harness is Chromium only, and layout is where
	// the engines part. An aisle icon was 0px wide in Firefox alone for
	// months.
	projects: [
		{ name: 'tiles-chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'tiles-firefox', use: { ...devices['Desktop Firefox'] } }
	]
});
