import { defineConfig, devices } from '@playwright/test';
import { basePort, viteDevServer } from '../server';

// Screenshots of the design gallery (scripts/shots.sh gallery): gallery.spec.ts
// opens each requested gallery state by URL and saves every preview it shows,
// for every comparison row — the before/after evidence for a change to the
// item components or app.css. Not a test harness; neither the gate nor CI
// runs it.
//
// Like the tile audit (tiles/tiles.config.ts, whose comments explain the
// details), it runs the Vite dev server — the gallery is dev-only — with no
// backend, in a dev-server instance of its own (.svelte-kit-shots), so it runs
// beside scripts/dev.sh and beside a gate.
const PORT = basePort('8092');

export default defineConfig({
	testDir: './',
	testMatch: 'gallery.spec.ts',
	retries: 0,
	workers: 1,
	timeout: 300_000,
	reporter: [['list']],
	webServer: viteDevServer(PORT, 'shots'),
	use: { baseURL: `http://127.0.0.1:${PORT}` },
	projects: [
		{
			name: 'shots-gallery',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } }
		}
	]
});
