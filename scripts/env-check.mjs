#!/usr/bin/env node
// Holds the operator's files to the settings the server actually reads. The
// compose file hands .env to the app whole (`env_file`, [D-263]), so what an
// operator can set is what .env.example offers and the deployment reference
// explains: a setting the code reads but neither names is one nobody finds,
// and a name .env.example offers that nothing reads does nothing.
//
// "Read by the server" is every Go string literal that is exactly a
// SHOPPINGLIST_… or SQLITE_… name, outside tests, which is how every reader
// names its variable (envflag takes the name as a constant). The demo build's
// own settings (internal/demo) are not offered in .env.example, which runs the
// real image; they only have to be documented.
//
// Checks:
//   - docker-compose.yml hands .env to the app, and maps no server setting
//     itself (environment: wins over env_file, so a mapping would shadow .env)
//   - .env.example offers every setting the server reads, set or commented
//     out, except the few the reference alone explains
//   - docs/deploy-reference.md names every setting, the compose-only ones too
//   - every name .env.example offers is read by the server or by compose
//   - README.md carries docker-compose.yml verbatim, so a copy of it runs
//   - backend/settings.go, the names the server accepts at boot ([D-336]),
//     lists exactly these settings and compose's own, then the tooling's
//
//   node scripts/env-check.mjs   exit 1 and list each mismatch (CI)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => readFileSync(resolve(root, f), 'utf8');

const goFiles = execFileSync('git', ['ls-files', 'backend/*.go'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	// settings.go names them all, so it says nothing about what is read.
	.filter((f) => f && !f.endsWith('_test.go') && f !== 'backend/settings.go');
const serverReads = new Set();
const demoReads = new Set();
for (const f of goFiles) {
	for (const [, name] of read(f).matchAll(/"((?:SHOPPINGLIST|SQLITE)_[A-Z0-9_]*[A-Z0-9])"/g)) {
		(f.startsWith('backend/internal/demo/') ? demoReads : serverReads).add(name);
	}
}

// Read by Go's net/http, not by name in the app.
const stdlib = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);
// In the reference only: the hand-set OIDC endpoints are for the rare
// provider without discovery, and .env.example is issuer-only ([D-210]).
const referenceOnly = new Set([
	'SHOPPINGLIST_OIDC_AUTH_URL',
	'SHOPPINGLIST_OIDC_TOKEN_URL',
	'SHOPPINGLIST_OIDC_USERINFO_URL'
]);

const problems = [];
// Every ${NAME} compose fills in from .env.
const interpolated = new Set();
const compose = read('docker-compose.yml');
for (const m of compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) interpolated.add(m[1]);
// The shoppinglist service, by indentation.
const service = compose.match(/^ {2}shoppinglist:\n((?: {4}.*\n|\s*\n)*)/m)?.[1] ?? '';
if (!/^ {4}env_file: \.env$/m.test(service)) {
	problems.push(
		'docker-compose.yml: the shoppinglist service does not hand over .env (env_file: .env)'
	);
}
const envBlock = service.match(/^ {4}environment:\n((?: {6}.*\n|\s*\n)*)/m)?.[1] ?? '';
for (const [, name] of envBlock.matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)) {
	if (!stdlib.has(name)) {
		problems.push(
			`docker-compose.yml maps ${name} itself; .env hands it over, so leave it to env_file`
		);
	}
}

const example = read('.env.example');
const offered = new Set([...example.matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
for (const name of serverReads) {
	if (!offered.has(name) && !referenceOnly.has(name)) {
		problems.push(`.env.example does not offer ${name}, which the server reads`);
	}
}
for (const name of offered) {
	if (!serverReads.has(name) && !interpolated.has(name)) {
		problems.push(`.env.example offers ${name}, which neither the server nor compose reads`);
	}
}

if (!read('README.md').includes('```yaml\n' + compose + '```\n')) {
	problems.push(
		'README.md: its compose block is not docker-compose.yml verbatim; copy the file in'
	);
}

const reference = read('docs/deploy-reference.md');
for (const name of new Set([...serverReads, ...demoReads, ...interpolated])) {
	if (!new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(reference)) {
		problems.push(`docs/deploy-reference.md does not mention ${name}`);
	}
}

// The boot's list: the settings, then, after its "Not settings" comment, the
// names the repo's tooling sets around the servers it starts.
const [settingsPart, toolingPart = ''] = read('backend/settings.go').split('// Not settings');
const names = (text) =>
	new Set([...text.matchAll(/"(SHOPPINGLIST_[A-Z0-9_]+)"/g)].map((m) => m[1]));
const accepted = names(settingsPart);
const settings = new Set(
	[...serverReads, ...demoReads, ...interpolated].filter((n) => n.startsWith('SHOPPINGLIST_'))
);
for (const name of settings) {
	if (!accepted.has(name)) problems.push(`backend/settings.go does not accept ${name}, a setting`);
}
for (const name of accepted) {
	if (!settings.has(name)) {
		problems.push(
			`backend/settings.go accepts ${name}, which neither the server nor compose reads`
		);
	}
}
for (const name of names(toolingPart)) {
	if (settings.has(name)) problems.push(`backend/settings.go lists the setting ${name} as tooling`);
}

if (problems.length) {
	for (const p of problems) console.error(p);
	process.exit(1);
}
console.log(
	`env-check: ${serverReads.size} server settings, ${demoReads.size} demo settings, ${interpolated.size} compose variables, all consistent`
);
