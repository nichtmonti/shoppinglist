import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Dex as a Playwright webServer, for every config that signs in through it:
// the OIDC harness (oidc.config.ts) and the docs screenshots
// (shots/docs.config.ts).
//
// Dex's config is tools/dex/dev.yaml (what scripts/dev.sh runs) with the
// port, redirect URIs and users swapped in, so the client and the password
// stay one definition. backend/internal/dextest renders the same shape for
// the Go flow tests. Every user's password is "password"; a user signs in as
// `<name lowercased>@example.com`.

const REPO = resolve(import.meta.dirname, '../..');
const DEV_YAML = readFileSync(join(REPO, 'tools/dex/dev.yaml'), 'utf8');
const PASSWORD_HASH = DEV_YAML.match(/^ +hash: "([^"]+)"$/m)?.[1];

/** The client the app servers sign in with, as tools/dex/dev.yaml defines it. */
const DEX_CLIENT = { id: 'shoppinglist', secret: 'shoppinglist-secret' };

function dexConfig(port: string, redirectOrigins: string[], users: string[]): string {
	const cut = DEV_YAML.search(/^ +redirectURIs:$/m);
	if (cut === -1 || !PASSWORD_HASH) {
		throw new Error('dex-server.ts: tools/dex/dev.yaml no longer has redirectURIs/hash lines');
	}
	const head = DEV_YAML.slice(0, cut)
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n')
		.replaceAll('127.0.0.1:5556', `127.0.0.1:${port}`);
	const uris = redirectOrigins.map((o) => `"${o}/api/oauth2-redirect"`).join(', ');
	const entries = users
		.map(
			(name) => `  - email: "${name.toLowerCase()}@example.com"
    hash: "${PASSWORD_HASH}"
    username: "${name}"
    userID: "${name.toLowerCase()}"`
		)
		.join('\n');
	return `${head}    redirectURIs: [${uris}]
staticPasswords:
${entries}
`;
}

/**
 * Dex on `port`, accepting sign-ins back to each of `redirectOrigins`, with
 * `users`. Returns its issuer, the webServer entry and `appEnv`, an app
 * server's OIDC settings against it (discovery from the issuer's
 * .well-known document). Evaluated by the runner
 * and every worker; the config file it writes is identical each time.
 */
export function dexServer(port: string, redirectOrigins: string[], users: string[]) {
	const file = join(tmpdir(), `shoppinglist-dex-${port}.yaml`);
	writeFileSync(file, dexConfig(port, redirectOrigins, users));
	const issuer = `http://127.0.0.1:${port}/dex`;
	// `go tool` runs the tools/dex pin, Go's own way to run a tool a `tool`
	// directive declares; CI's image has Go too ([D-203]).
	const command = 'go -C tools/dex tool dex';
	return {
		issuer,
		appEnv: {
			SHOPPINGLIST_OIDC: 'on',
			SHOPPINGLIST_OIDC_CLIENT_ID: DEX_CLIENT.id,
			SHOPPINGLIST_OIDC_CLIENT_SECRET: DEX_CLIENT.secret,
			SHOPPINGLIST_OIDC_ISSUER: issuer,
			SHOPPINGLIST_OIDC_NAME: 'Dex'
		},
		webServer: {
			command: `${command} serve ${file}`,
			cwd: REPO,
			url: `${issuer}/.well-known/openid-configuration`,
			reuseExistingServer: false,
			timeout: 180_000
		}
	};
}
