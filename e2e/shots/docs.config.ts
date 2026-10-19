import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { dexServer } from '../oidc/dex-server';
import { appServer, basePort } from '../server';
import { PHONE } from './shots';

// Screenshots for the deployment reference (scripts/shots.sh docs): the
// screens docs/deploy-reference.md describes in words. An instance with
// SHOPPINGLIST_SIGNUP=invite for who-can-sign-up, and one with the OIDC login
// against Dex for the provider button and the settings card. Not a test
// harness: nothing asserts on the product, and neither the gate nor CI runs it.
//
// Fresh databases every run, so the images show only what docs.spec.ts makes.
const PORT = basePort('8087');
const INVITE_PORT = process.env.E2E_DOCS_INVITE_PORT ?? '8086';
const DEX_PORT = process.env.E2E_DEX_PORT ?? '5558';

export const INVITE_ORIGIN = `http://localhost:${INVITE_PORT}`;
// The invite-only server's output, where docs.spec.ts finds the setup link.
export const INVITE_LOG = join(tmpdir(), `shoppinglist-docs-invite-${INVITE_PORT}.log`);

const DEX = dexServer(DEX_PORT, [`http://localhost:${PORT}`], ['Anna', 'Ben']);

export default defineConfig({
	testDir: './',
	testMatch: 'docs.spec.ts',
	retries: 0,
	workers: 1,
	timeout: 300_000,
	expect: { timeout: 30_000 },
	reporter: [['list']],
	webServer: [
		DEX.webServer,
		appServer(PORT, { E2E_FRESH_DATA: '1', ...DEX.appEnv }),
		appServer(INVITE_PORT, {
			E2E_FRESH_DATA: '1',
			SHOPPINGLIST_SIGNUP: 'invite',
			E2E_SERVER_LOG: INVITE_LOG
		})
	],
	use: { baseURL: `http://localhost:${PORT}`, ...PHONE },
	projects: [{ name: 'shots-docs', use: { ...devices['Desktop Chrome'], ...PHONE } }]
});
