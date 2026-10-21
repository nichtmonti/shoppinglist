// Vitest globalSetup for the integration project: builds (or reuses) the real
// backend binary, boots it on a temp data directory, and tears it down after.
//
// The point of this suite is that NOTHING here is a fake — the client modules
// under test talk to the same binary CI ships. That is what makes it catch wire
// drift between backend/internal/sync (Go structs) and src/lib/sync/types.ts,
// which every other layer of the test pyramid verifies only by inspection.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_URL, PORT, SUPERUSER_EMAIL, SUPERUSER_PASSWORD } from './config';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '../../../backend');

let server: ChildProcess | null = null;
let dataDir: string | null = null;

// The passkey routes refuse to start without an RP id (§5.7). Integration
// scenarios authenticate via superuser impersonation, not WebAuthn, but the
// binary still needs these set to boot.
const serverEnv = {
	...process.env,
	// On the RP-ID's host, or the server refuses to boot. The requests go to
	// BASE_URL's 127.0.0.1, which Node's fetch sends without an Origin, so the
	// two never have to agree.
	SHOPPINGLIST_RP_ID: 'localhost',
	SHOPPINGLIST_RP_ORIGIN: `http://localhost:${PORT}`,
	// behaviour/world.ts gives every simulated device its own client address, as
	// separate phones have: PocketBase's limits are per IP, and one shared address
	// for a whole stress run would measure the rate limiter, not sync. Requests
	// without the header (every other test here) keep the socket address.
	SHOPPINGLIST_TRUSTED_PROXY_HEADER: 'X-Forwarded-For'
};

// Resolve the backend binary. The gate and CI build it (`task build-backend`)
// and pass the path; otherwise it is built here.
function resolveBinary(outDir: string): string {
	const override = process.env.SHOPPINGLIST_BIN;
	if (override) return path.resolve(override);

	const out = path.join(outDir, 'shoppinglist');
	// -tags no_ui ([D-64]): this suite is API-only, so embedding the SPA would
	// buy nothing — and on a tree with a leftover backend/pb_public it would
	// silently compile a stale SPA into the binary under test.
	const built = spawnSync('go', ['build', '-tags', 'no_ui', '-o', out, '.'], {
		cwd: backendDir,
		stdio: 'inherit'
	});
	if (built.error ?? built.status !== 0) {
		throw new Error(
			`failed to build the backend binary (${built.error?.message ?? `exit ${built.status}`}). ` +
				`Install Go, or point SHOPPINGLIST_BIN at a prebuilt binary.`
		);
	}
	return out;
}

// Tail of the backend's own output, replayed only if the boot fails.
const logTail: string[] = [];
function recordLog(chunk: Buffer): void {
	logTail.push(chunk.toString());
	if (logTail.length > 40) logTail.shift();
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = 'no attempt made';
	while (Date.now() < deadline) {
		if (server?.exitCode != null) {
			throw new Error(`backend exited early with code ${server.exitCode}\n${logTail.join('')}`);
		}
		try {
			const resp = await fetch(`${BASE_URL}/api/health`);
			if (resp.ok) return;
			lastError = `status ${resp.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(
		`backend did not become healthy on ${BASE_URL}: ${lastError}\n${logTail.join('')}`
	);
}

export async function setup(): Promise<void> {
	dataDir = mkdtempSync(path.join(tmpdir(), 'shoppinglist-integration-'));
	const binary = resolveBinary(dataDir);

	// Superuser creation runs against the data dir BEFORE serve, so the very
	// first request in the suite can already authenticate as admin.
	const upsert = spawnSync(
		binary,
		['superuser', 'upsert', SUPERUSER_EMAIL, SUPERUSER_PASSWORD, `--dir=${dataDir}`],
		{ env: serverEnv, encoding: 'utf8' }
	);
	if (upsert.status !== 0) {
		throw new Error(`superuser upsert failed: ${upsert.stderr || upsert.stdout}`);
	}

	server = spawn(binary, ['serve', `--http=127.0.0.1:${PORT}`, `--dir=${dataDir}`], {
		env: serverEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// Both streams MUST be drained. PocketBase logs every seed statement on
	// startup, which is far more than a pipe buffer holds — leaving stdout
	// unread blocks the child before it ever binds the port.
	server.stdout?.on('data', recordLog);
	server.stderr?.on('data', recordLog);

	await waitForHealth();
}

export async function teardown(): Promise<void> {
	if (server && server.exitCode == null) {
		const exited = new Promise<void>((resolve) => server?.once('exit', () => resolve()));
		server.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
		if (server.exitCode == null) server.kill('SIGKILL');
	}
	server = null;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = null;
}
