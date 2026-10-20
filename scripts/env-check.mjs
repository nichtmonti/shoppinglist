#!/usr/bin/env node
// Holds the operator's files to the settings the server actually reads. The
// compose file hands .env to the app whole (`env_file`, [D-263]), so what an
// operator can set is what .env.example offers and the deployment reference
// explains: a setting the code reads but neither names is one nobody finds,
// and a name .env.example offers that nothing reads does nothing.
//
// "Read by the server" is every `env` tag in backend/internal/settings, the one
// declaration of the settings ([D-337]); its test renders the reference's
// tables from it. The demo build's own settings (its Demo struct) are not
// offered in .env.example, which runs the real image.
//
// Checks:
//   - docker-compose.yml hands .env to the app, and maps no server setting
//     itself (environment: wins over env_file, so a mapping would shadow .env)
//   - .env.example offers every setting the server reads, set or commented
//     out, except the few the reference alone explains
//   - docs/deploy-reference.md names every setting, the compose-only ones too
//   - no server code names a SHOPPINGLIST_ variable the settings do not
//     declare: a setting is read through internal/settings or not at all
//   - every name .env.example offers is read by the server or by compose
//   - README.md carries docker-compose.yml verbatim, so a copy of it runs
//   - settings.Others, the names the start's check passes without reading
//     ([D-336]), lists exactly compose's own, then the tooling's
//
//   node scripts/env-check.mjs   exit 1 and list each mismatch (CI)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => readFileSync(resolve(root, f), 'utf8');

const settingsFile = 'backend/internal/settings/settings.go';
const settingsGo = read(settingsFile);
const tags = (text) => new Set([...text.matchAll(/env:"([A-Z_][A-Z0-9_]*)"/g)].map((m) => m[1]));
const demoStruct = settingsGo.match(/^type Demo struct \{\n[\s\S]*?^\}/m)?.[0] ?? '';
const demoReads = tags(demoStruct);
const serverReads = new Set([...tags(settingsGo)].filter((n) => !demoReads.has(n)));
const quoted = (text) =>
	new Set([...text.matchAll(/"((?:SHOPPINGLIST|SQLITE)_[A-Z0-9_]*[A-Z0-9])"/g)].map((m) => m[1]));
const othersBlock = settingsGo.match(/^var Others = \[\]string\{\n[\s\S]*?^\}/m)?.[0] ?? '';
const [composePart, toolingPart = ''] = othersBlock.split('// Not settings');

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

// What the start passes without reading: compose's own, then the tooling's.
const composeOwn = quoted(composePart);
for (const name of interpolated) {
	if (name.startsWith('SHOPPINGLIST_') && !composeOwn.has(name)) {
		problems.push(`settings.Others does not pass ${name}, which docker-compose.yml fills in`);
	}
}
for (const name of composeOwn) {
	if (!interpolated.has(name))
		problems.push(`settings.Others passes ${name} as compose's, which compose does not read`);
}
const known = new Set([...serverReads, ...demoReads, ...composeOwn, ...quoted(toolingPart)]);
for (const name of quoted(toolingPart)) {
	if (serverReads.has(name) || demoReads.has(name))
		problems.push(`settings.Others lists the setting ${name} as tooling`);
}
// A setting is read through internal/settings or not at all.
const goFiles = execFileSync('git', ['ls-files', 'backend/*.go'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && !f.endsWith('_test.go'));
for (const f of goFiles) {
	for (const name of quoted(read(f))) {
		if (name.startsWith('SHOPPINGLIST_') && !known.has(name)) {
			problems.push(`${f} names ${name}, which internal/settings does not declare`);
		}
	}
}

if (problems.length) {
	for (const p of problems) console.error(p);
	process.exit(1);
}
console.log(
	`env-check: ${serverReads.size} server settings, ${demoReads.size} demo settings, ${interpolated.size} compose variables, all consistent`
);
