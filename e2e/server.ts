import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// What every Playwright harness config shares: the port it runs on, the app
// server it boots or the Vite dev server, and the browser locale.

const REPO = resolve(import.meta.dirname, '..');

/** The harness's port: E2E_PORT, else `fallback`. */
export function basePort(fallback: string): string {
	return process.env.E2E_PORT ?? fallback;
}

/**
 * One app server on `port`, with the WebAuthn RP set to its own origin.
 * `extra` adds or overrides environment variables, and switches two of its own:
 * `E2E_FRESH_DATA` starts from an empty database (a harness whose identities
 * are fixed, as e2e/oidc's Dex users), `E2E_SUPERUSER` creates SUPERUSER.
 * A harness owns its whole origin, so it never adopts a running server:
 * Playwright refuses a port that already answers, scripts/dev.sh's included
 * ([D-157]).
 *
 * The binary is SHOPPINGLIST_BIN, which every task sets, else
 * backend/shoppinglist; nothing is built here.
 */
export function appServer(port: string, extra: Record<string, string> = {}) {
	const bin = extra.SHOPPINGLIST_BIN ?? process.env.SHOPPINGLIST_BIN ?? 'backend/shoppinglist';
	if (!existsSync(resolve(REPO, bin))) {
		throw new Error(
			`no ${bin}: build it first (\`task build-app\`, the demo's \`task build-demo\`), ` +
				'or run the harness through scripts/gate.sh e2e:<name>, which does'
		);
	}
	// The data dir follows the port, so a run on another port starts clean
	// rather than inheriting the default run's accounts.
	const data = `/tmp/e2e_pbdata_${port}`;
	const steps = [
		extra.E2E_FRESH_DATA && `rm -rf ${data}`,
		extra.E2E_SUPERUSER &&
			`${bin} superuser upsert ${SUPERUSER.email} ${SUPERUSER.password} --dir=${data} >/dev/null`,
		`exec ${bin} serve --http=127.0.0.1:${port} --dir=${data}`
	];
	return {
		command: steps.filter(Boolean).join(' && '),
		cwd: REPO,
		url: `http://127.0.0.1:${port}/api/health`,
		reuseExistingServer: false,
		timeout: 180_000,
		// A stop it can finish: a binary built with -cover writes what the
		// suite reached only on a normal exit, and Playwright's default is
		// SIGKILL ([D-203]).
		gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
		env: {
			SHOPPINGLIST_RP_ID: 'localhost',
			SHOPPINGLIST_RP_ORIGIN: `http://localhost:${port}`,
			// tests/fixtures.ts gives every test its own client address in this
			// header, so the per-IP budgets see separate people ([D-223]).
			SHOPPINGLIST_TRUSTED_PROXY_HEADER: 'X-Forwarded-For',
			...extra
		}
	};
}

/**
 * The Vite dev server on `port`, with no backend, for the harnesses that open
 * the design gallery (/dev/gallery), which the built SPA does not contain.
 * `instance` names its own generated tree and dep cache
 * (SHOPPINGLIST_DEV_INSTANCE in vite.config.ts), so it runs beside
 * scripts/dev.sh.
 */
export function viteDevServer(port: string, instance: string) {
	return {
		// Vite straight from node, not `pnpm exec`: pnpm's native shim starts
		// its child in a process group of its own, which Playwright's teardown
		// signal does not reach, so the run would hang after its last test.
		command: `node node_modules/vite/bin/vite.js dev --port ${port} --strictPort`,
		cwd: join(REPO, 'frontend'),
		url: `http://127.0.0.1:${port}/dev/gallery`,
		reuseExistingServer: false,
		timeout: 180_000,
		env: { HOST: '127.0.0.1', SHOPPINGLIST_DEV_INSTANCE: instance }
	};
}

/**
 * An invite-only app server ([D-241]): SHOPPINGLIST_SIGNUP=invite on an empty
 * database. It is up once it has printed the first account's setup link, which
 * Playwright's own `wait` copies to process.env.SETUP_LINK for the specs.
 */
export function inviteOnlyServer(port: string) {
	return {
		...appServer(port, { SHOPPINGLIST_SIGNUP: 'invite', E2E_FRESH_DATA: '1' }),
		// The link, not the health URL: Playwright takes whichever comes first.
		url: undefined,
		wait: { stderr: /(?<setup_link>https?:\/\/\S+\/#setup=[\w-]+)/ }
	};
}

/** The functional suite's invite-only instance, beside its own server. */
export const INVITE_PORT = process.env.E2E_INVITE_PORT ?? '8089';

/**
 * The superuser appServer creates when the harness sets `E2E_SUPERUSER`:
 * the functional suite's way to put a product photo in the barcode cache
 * (seedProductPhoto in tests/helpers.ts). The server listens on loopback only.
 */
export const SUPERUSER = { email: 'e2e@example.invalid', password: 'e2e-photo-seed-password' };

// The specs assert German copy. Paraglide's base locale is 'en' (§12.2), so
// the browser's `navigator.language` has to start with 'de' for the app's
// locale detection to pick German at boot — which also exercises that
// detection path with a real browser locale. locale.spec.ts overrides it per
// test to cover English.
export const LOCALE = 'de-DE';
