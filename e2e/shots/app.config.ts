import { defineConfig, devices } from '@playwright/test';
import { appServer, basePort } from '../server';
import { PHONE } from './shots';

// Screenshots of the real app (scripts/shots.sh app|readme): app.spec.ts
// signs up a household on a fresh server and photographs its central screens
// in each locale and theme. Not a test harness — nothing here asserts on
// the product — so neither the gate nor CI runs it.
//
// Its own port and a fresh database per run (E2E_FRESH_DATA): the images
// show exactly the household the script builds, nothing a previous run left.
const PORT = basePort('8091');

export default defineConfig({
	testDir: './',
	testMatch: 'app.spec.ts',
	retries: 0,
	workers: 1,
	timeout: 300_000,
	expect: { timeout: 30_000 },
	reporter: [['list']],
	webServer: appServer(PORT, { E2E_FRESH_DATA: '1' }),
	use: { baseURL: `http://localhost:${PORT}`, ...PHONE },
	projects: [{ name: 'shots-app', use: { ...devices['Desktop Chrome'], ...PHONE } }]
});
