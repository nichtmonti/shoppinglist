import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// What every Playwright harness config shares: the port it runs on, the app
// server it boots (run-server.sh) or the Vite dev server, and the browser
// locale.

const REPO = resolve(import.meta.dirname, '..');

// The ports of scripts/dev.sh (backend 8090, Vite 5173). A harness owns its
// whole origin — the passkey ceremonies are signed against RP_ORIGIN below —
// so a run on a dev port would reuse the dev server and every ceremony would
// fail on an origin mismatch. Refusing them is what lets the harnesses run
// while dev.sh is up ([D-157]).
const DEV_PORTS = ['8090', '5173'];

/** The harness's port: E2E_PORT, else `fallback`. Refuses the dev ports. */
export function basePort(fallback: string): string {
	const port = process.env.E2E_PORT ?? fallback;
	if (DEV_PORTS.includes(port)) {
		throw new Error(
			`E2E_PORT=${port} is a scripts/dev.sh port; Playwright would reuse the dev ` +
				`server and every passkey ceremony would fail on its origin. Use ${fallback}.`
		);
	}
	return port;
}

/**
 * One app server on `port` (e2e/run-server.sh), with the WebAuthn RP set to
 * its own origin. `extra` adds or overrides environment variables;
 * `reuseExisting` adopts a server already answering on the port.
 */
export function appServer(
	port: string,
	extra: Record<string, string> = {},
	{ reuseExisting = false }: { reuseExisting?: boolean } = {}
) {
	return {
		command: 'bash e2e/run-server.sh',
		cwd: REPO,
		url: `http://127.0.0.1:${port}/api/health`,
		reuseExistingServer: reuseExisting,
		timeout: 180_000,
		// A stop it can finish: a binary built with -cover writes what the
		// suite reached only on a normal exit, and Playwright's default is
		// SIGKILL ([D-203]).
		gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
		env: {
			E2E_PORT: port,
			SHOPPINGLIST_RP_ID: 'localhost',
			SHOPPINGLIST_RP_ORIGIN: `http://localhost:${port}`,
			// tests/fixtures.ts gives every test its own client address in this
			// header, so the per-IP budgets see separate people ([D-223]).
			SHOPPINGLIST_TRUSTED_PROXY_HEADER: 'X-Forwarded-For',
			E2E_SUPERUSER_EMAIL: SUPERUSER.email,
			E2E_SUPERUSER_PASSWORD: SUPERUSER.password,
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
 * The invite-only instance the functional suite boots beside its own server
 * ([D-241]): SHOPPINGLIST_SIGNUP=invite on an empty database, whose output
 * run-server.sh copies to `log` — the setup link it prints at boot is
 * invite-signup.spec.ts's way in.
 */
export function inviteOnlyServer() {
	const port = process.env.E2E_INVITE_PORT ?? '8089';
	return {
		port,
		origin: `http://localhost:${port}`,
		log: join(tmpdir(), `shoppinglist-invite-${port}.log`)
	};
}

/**
 * The superuser run-server.sh creates when the harness sets `E2E_SUPERUSER`:
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
