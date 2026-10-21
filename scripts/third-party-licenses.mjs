// Generates docs/THIRD_PARTY_LICENSES.md: every third-party component the release
// SHIPS, with its licence and copyright, followed by the full text of each
// distinct licence and every NOTICE it carries. Needs Go, node and frontend/'s
// installed dependencies: run it in the devcontainer. It runs a real `vite
// build` (~30s), which rewrites frontend/build and frontend/.svelte-kit like
// any build.
//
// What ships, and how each part is found rather than listed by hand:
//
//   - The Go binary: the modules `go list -deps` reports for the main package
//     of backend/, as GoReleaser builds it (no build tags, CGO_ENABLED=0,
//     linux/amd64 + linux/arm64, unioned). Test-only and tools/ modules are not
//     in that graph, so they are not listed. Their licence files are read
//     from the module cache, the standard library's from GOROOT.
//   - The SPA embedded in it: a real `vite build` of frontend/, with a
//     collector plugin added through a throwaway config that wraps
//     frontend/vite.config.ts (written under node_modules/.cache, deleted
//     after). It records every node_modules module that contributes rendered
//     code to a CLIENT chunk, every client-side CSS module plus the bare
//     @imports Tailwind resolves itself (tailwindcss, tw-animate-css), and the
//     original file of every emitted asset (fonts, the zxing wasm). Whether a
//     package is a dependency or a devDependency does not matter — only
//     whether its code lands in the build. The SSR build SvelteKit runs for
//     prerendering is ignored: it does not ship.
//   - Components that are inside a shipped package but carry their own
//     licence (zxing-cpp in zxing-wasm's wasm, SQLite in modernc.org/sqlite)
//     are listed from SUPPLEMENTS below, which is the one hand-kept part.
//
// The run fails (exit 1) when a component's licence cannot be classified or
// is not on ALLOWED — a new copyleft or unknown licence must stop a
// regeneration, not slip into the notice. `--check` compares instead of
// writing, for CI (.woodpecker/e2e.yaml); `task licenses` runs it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import satisfies from 'spdx-satisfies';

const ROOT = path.resolve(import.meta.dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const BACKEND = path.join(ROOT, 'backend');
const OUT = path.join(ROOT, 'docs', 'THIRD_PARTY_LICENSES.md');
const SBOM_OUT = path.join(ROOT, 'docs', 'sbom.cdx.json');
const CHECK = process.argv.includes('--check');

// Compatible with distributing the combined work under AGPL-3.0-only. MPL-2.0
// would be too (file-level copyleft) but is deliberately absent so that one
// arriving is looked at first; likewise every GPL/LGPL variant.
const ALLOWED = new Set([
	'MIT',
	'ISC',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'Apache-2.0',
	'0BSD',
	'Unlicense',
	'CC0-1.0',
	'blessing', // SQLite's public-domain dedication
	'OFL-1.1', // fonts: the licence ships with them (this file)
	'CC-BY-SA-4.0' // OpenMoji artwork: attribution in the app's settings footer
]);

/** Whether the SPDX expression can be met with ALLOWED licences alone. */
function allowedLicence(expression) {
	try {
		return satisfies(expression, [...ALLOWED]);
	} catch {
		return false;
	}
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|patents|unlicense)([-._].*)?$/i;

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

function licenseFiles(dir) {
	return readdirSync(dir)
		.filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
		.sort()
		.map((f) => ({
			name: f,
			text: readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')
		}));
}

// A copyright STATEMENT, not licence prose that mentions copyright ("the
// above copyright notice", "COPYRIGHT HOLDERS BE LIABLE"): it carries a ©,
// a (c) or a year.
const COPYRIGHT = /^\s*(?:copyright\b.*?(?:\(c\)|©|\b(?:19|20)\d{2}\b)|\(c\)\s*(?:19|20)\d{2}|©)/i;

function copyrightLines(files) {
	const out = [];
	for (const f of files) {
		for (const line of f.text.split('\n')) {
			const l = line.trim();
			// "Copyright [yyyy] [name of copyright owner]" is the Apache appendix.
			if (
				COPYRIGHT.test(l) &&
				!/\[yyyy\]|\{yyyy\}|<year>/i.test(l) &&
				l.length < 200 &&
				!out.includes(l)
			)
				out.push(l);
		}
	}
	return out;
}

/** SPDX id from a licence text, or null. Only the main licence file counts. */
function classify(text) {
	const t = text.replace(/\s+/g, ' ');
	if (/Apache License,? Version 2\.0/i.test(t)) return 'Apache-2.0';
	if (/Mozilla Public License,? (Version )?2\.0/i.test(t)) return 'MPL-2.0';
	if (/GNU (LESSER|LIBRARY) GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL';
	if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL';
	if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL';
	if (/Attribution-ShareAlike 4\.0 International/i.test(t)) return 'CC-BY-SA-4.0';
	if (/SIL OPEN FONT LICENSE Version 1\.1/i.test(t)) return 'OFL-1.1';
	if (/Permission is hereby granted, free of charge, to any person/i.test(t)) return 'MIT';
	if (
		/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i.test(
			t
		)
	)
		return /provided that the above copyright notice/i.test(t) ? 'ISC' : '0BSD';
	if (/Redistribution and use in source and binary forms/i.test(t))
		return /Neither the name|names of its contributors/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
	if (/This is free and unencumbered software released into the public domain/i.test(t))
		return 'Unlicense';
	if (/CC0 1\.0 Universal/i.test(t)) return 'CC0-1.0';
	return null;
}

function mainLicense(files) {
	const main =
		files.find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f.name)) ??
		files.find((f) => /^(licen|copying)/i.test(f.name));
	return main ? classify(main.text) : null;
}

/** package.json `license` in its many historical shapes, as one string. */
function npmLicenseField(pkg) {
	const l = pkg.license ?? pkg.licenses;
	if (!l) return null;
	if (typeof l === 'string') return l;
	if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ');
	return l.type ?? null;
}

// ---------------------------------------------------------------- Go

function goComponents() {
	const go = (args, env = {}) =>
		run('go', args, { cwd: BACKEND, env: { ...process.env, GOFLAGS: '', ...env } });
	const modules = new Map();
	for (const GOARCH of ['amd64', 'arm64']) {
		const out = go(
			[
				'list',
				// no_ui: the SPA it would embed is not built here, and the tag
				// changes no import. Without -e, a package that fails to load
				// stops the run instead of leaving its modules out.
				'-tags',
				'no_ui',
				'-deps',
				'-f',
				'{{if not .Standard}}{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{if .Replace}}{{.Replace.Dir}}{{else}}{{.Dir}}{{end}}{{end}}{{end}}{{end}}',
				'.'
			],
			{ CGO_ENABLED: '0', GOOS: 'linux', GOARCH }
		);
		for (const line of out.split('\n').filter(Boolean)) {
			const [name, version, dir] = line.split('\t');
			if (!dir || !existsSync(dir))
				throw new Error(`${name}@${version} is not in the module cache (run go mod download)`);
			modules.set(line, { name, version, dir });
		}
	}
	modules.set('stdlib', {
		name: 'Go standard library and runtime',
		version: go(['env', 'GOVERSION']).trim(),
		dir: go(['env', 'GOROOT']).trim()
	});
	return [...modules.values()]
		.map(({ name, version, dir }) => {
			const files = licenseFiles(dir);
			return { eco: 'go', name, version, files, license: mainLicense(files) };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- npm

// The collector runs inside both of SvelteKit's builds (the client build is a
// secondary vite.build of the same config file) and writes what it saw in the
// client one to SHOPPINGLIST_TPL_OUT.
const COLLECTOR_CONFIG = `
import { defineConfig } from 'vite';
import { writeFileSync } from 'node:fs';
import base from ${JSON.stringify(path.join(FRONTEND, 'vite.config.ts'))};

const seen = { modules: new Set(), css: new Set(), assets: new Set() };
const isClient = (ctx) => (ctx.environment ? ctx.environment.name === 'client' : true);

function collector() {
	return {
		name: 'third-party-licenses-collector',
		enforce: 'post',
		transform(code, id) {
			if (!isClient(this) || this.environment?.config?.build?.ssr) return;
			if (/\\.css($|\\?)/.test(id)) seen.css.add(id);
		},
		generateBundle(opts, bundle) {
			if (!isClient(this) || this.environment?.config?.build?.ssr) return;
			for (const out of Object.values(bundle)) {
				if (out.type === 'chunk') {
					for (const [id, info] of Object.entries(out.modules)) if (info.renderedLength > 0) seen.modules.add(id);
				} else {
					for (const f of out.originalFileNames ?? []) seen.assets.add(f);
				}
			}
			writeFileSync(process.env.SHOPPINGLIST_TPL_OUT, JSON.stringify({
				modules: [...seen.modules],
				css: [...seen.css],
				assets: [...seen.assets]
			}));
		}
	};
}

export default defineConfig(async (env) => {
	const cfg = typeof base === 'function' ? await base(env) : await base;
	return { ...cfg, plugins: [...cfg.plugins, collector()] };
});
`;

function nearestPackage(file) {
	let dir = path.dirname(file);
	while (dir !== path.dirname(dir)) {
		const pj = path.join(dir, 'package.json');
		if (existsSync(pj)) {
			const pkg = JSON.parse(readFileSync(pj, 'utf8'));
			// Skip nested {"type": "module"} stubs: a package root has a name.
			if (pkg.name && pkg.version) return { dir, pkg };
		}
		dir = path.dirname(dir);
	}
	return null;
}

function npmComponents() {
	const tmp = path.join(FRONTEND, 'node_modules', '.cache', 'third-party-licenses');
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	const config = path.join(tmp, 'vite.config.mjs');
	const report = path.join(tmp, 'report.json');
	writeFileSync(config, COLLECTOR_CONFIG);
	try {
		const vite = path.join(FRONTEND, 'node_modules', 'vite', 'bin', 'vite.js');
		run(process.execPath, [vite, 'build', '--config', config, '--logLevel', 'error'], {
			cwd: FRONTEND,
			env: { ...process.env, SHOPPINGLIST_TPL_OUT: report },
			stdio: ['ignore', 'ignore', 'inherit']
		});
		const seen = JSON.parse(readFileSync(report, 'utf8'));
		const files = [
			...seen.modules,
			...seen.css,
			...seen.assets.map((f) => path.resolve(FRONTEND, f))
		];
		// Bare CSS @imports Tailwind inlines itself (tailwindcss,
		// tw-animate-css) are no Vite module of their own: read them from the
		// app's own stylesheets as written.
		const cssImports = new Set();
		for (const id of seen.css) {
			const file = id.replace(/\?.*$/, '');
			if (file.includes(`${path.sep}node_modules${path.sep}`) || !existsSync(file)) continue;
			for (const m of readFileSync(file, 'utf8').matchAll(/@import\s+['"]([^'"./][^'"]*)['"]/g))
				cssImports.add(m[1]);
		}
		for (const spec of cssImports) {
			const name = spec.startsWith('@')
				? spec.split('/').slice(0, 2).join('/')
				: spec.split('/')[0];
			files.push(path.join(FRONTEND, 'node_modules', name, 'package.json'));
		}
		const pkgs = new Map();
		let paraglide = false;
		for (let f of files) {
			f = f.replace(/^\0/, '').replace(/\?.*$/, '');
			if (!path.isAbsolute(f) || !existsSync(f)) continue;
			f = realpathSync(f);
			if (f.startsWith(path.join(FRONTEND, 'src', 'lib', 'paraglide') + path.sep)) paraglide = true;
			if (!f.includes(`${path.sep}node_modules${path.sep}`)) continue;
			const hit = nearestPackage(f);
			if (hit) pkgs.set(hit.dir, hit);
		}
		// Paraglide compiles its runtime INTO src/lib/paraglide, so the code
		// ships without any module of it living in node_modules.
		if (paraglide) {
			const real = realpathSync(path.join(FRONTEND, 'node_modules', '@inlang', 'paraglide-js'));
			pkgs.set(real, {
				dir: real,
				pkg: JSON.parse(readFileSync(path.join(real, 'package.json'), 'utf8'))
			});
		}
		return [...pkgs.values()]
			.map(({ dir, pkg }) => {
				const files = licenseFiles(dir);
				const declared = npmLicenseField(pkg);
				const detected = mainLicense(files);
				const c = {
					eco: 'npm',
					dir,
					name: pkg.name,
					version: pkg.version,
					files,
					license: declared ?? detected,
					detected,
					author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
				};
				NPM_OVERRIDES[pkg.name]?.(c);
				return c;
			})
			.sort(
				(a, b) =>
					a.name.localeCompare(b.name) ||
					a.version.localeCompare(b.version, 'en', { numeric: true })
			);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// Packages whose licence the generic reading gets wrong, each with why. An
// entry here must be re-checked when its package updates.
const NPM_OVERRIDES = {
	// One LICENSE file, two licences: ISC for Lucide, MIT for the icons it
	// derived from Feather. The MIT wording matches first, hence the override.
	'@lucide/svelte': (c) => {
		c.license = 'ISC AND MIT';
		c.detected = null;
	},
	// The artwork's licence carries no copyright line; OpenMoji asks for this
	// credit (its README, "Attribution Requirements"). Only the SVG artwork
	// ships — the package's LGPL-3.0 code (index.js, helpers/) is not bundled.
	openmoji: (c) => {
		c.copyright = [
			'All emojis designed by OpenMoji – the open-source emoji and icon project (https://openmoji.org). License: CC BY-SA 4.0'
		];
	},
	// Publishes no LICENSE file; MIT is stated in the header of the module the
	// app bundles. The header is reproduced, with the MIT terms it cites.
	'qrcode-generator': (c) => {
		const header = readFileSync(path.join(c.dir, 'dist', 'qrcode.mjs'), 'utf8')
			.split(/\n(?!\/\/)/)[0] // the leading comment block
			.split('\n')
			.map((l) => l.replace(/^\/\/[-\s]*/, ''))
			.join('\n')
			.trim();
		if (!/MIT license/i.test(header))
			throw new Error(
				'qrcode-generator: dist/qrcode.mjs no longer states the MIT licence; re-check NPM_OVERRIDES'
			);
		c.files = [
			{ name: 'dist/qrcode.mjs header', text: header },
			{ name: 'MIT terms', text: MIT_TERMS }
		];
		c.detected = null;
	}
};

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// ---------------------------------------------------------------- supplements

const APACHE_FROM = (comps) => {
	const c = comps.find(
		(x) => x.license === 'Apache-2.0' && x.files.some((f) => classify(f.text) === 'Apache-2.0')
	);
	return c.files.find((f) => classify(f.text) === 'Apache-2.0').text;
};

// Components compiled into a shipped package whose licence file does not say
// so. Keep in step with the packages they ride in.
const SUPPLEMENTS = [
	{
		inside: 'zxing-wasm',
		name: 'zxing-cpp (compiled into zxing-wasm/reader/zxing_reader.wasm)',
		license: 'Apache-2.0',
		copyright: [
			'Copyright 2016 Nu-book Inc.',
			'Copyright 2016 ZXing authors',
			'and the zxing-cpp contributors (per its source file headers)'
		],
		note: 'zxing-wasm README, "Licenses": zxing-cpp and src/cpp/ZXingWasm.cpp are Apache-2.0. The reader build used here does not contain zint (the writer\'s BSD-3-Clause encoder).',
		text: APACHE_FROM
	}
];

// ---------------------------------------------------------------- render

function render(goComps, npmComps) {
	const all = [...goComps, ...npmComps];
	for (const s of SUPPLEMENTS) {
		const host = npmComps.find((c) => c.name === s.inside);
		if (!host) continue; // the package no longer ships: nothing to supplement
		all.push({
			eco: 'embedded',
			name: s.name,
			version: `via ${host.name} ${host.version}`,
			license: s.license,
			copyright: s.copyright,
			note: s.note,
			files: [{ name: 'LICENSE', text: s.text(all) }]
		});
	}

	for (const c of all) {
		c.copyright ??= copyrightLines(c.files);
		if (!c.copyright.length && c.author) c.copyright = [`${c.author} (author per package.json)`];
	}

	// One copy of each distinct licence text: copyright lines stripped (they
	// are in the tables and repeated per group), whitespace normalised.
	const groups = new Map();
	for (const c of all) {
		for (const f of c.files) {
			const body = f.text
				.split('\n')
				.filter((l) => !COPYRIGHT.test(l.trim()))
				.join('\n')
				.trim();
			const key = createHash('sha256').update(body.replace(/\s+/g, ' ')).digest('hex').slice(0, 12);
			if (!groups.has(key))
				groups.set(key, {
					body,
					kind: /^notice/i.test(f.name)
						? 'NOTICE'
						: /^patents/i.test(f.name)
							? 'PATENTS'
							: (/^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f.name) && classify(f.text)) || f.name,
					key,
					members: []
				});
			groups.get(key).members.push({ c, file: f.name });
		}
	}

	const cell = (s) => String(s).replace(/\|/g, '\\|');
	const table = (comps) =>
		[
			'| Component | Version | License | Copyright |',
			'| --- | --- | --- | --- |',
			...comps.map(
				(c) =>
					`| ${cell(c.name)} | ${cell(c.version)} | ${cell(c.license)} | ${cell(c.copyright.join('<br>') || '—')} |`
			)
		].join('\n');

	const goTable = all.filter((c) => c.eco === 'go');
	const npmTable = all.filter((c) => c.eco === 'npm');
	const embTable = all.filter((c) => c.eco === 'embedded');
	const fence = (s) => {
		let f = '```';
		while (s.includes(f)) f += '`';
		return `${f}text\n${s}\n${f}`;
	};

	return `# Third-party licenses

<!-- Generated by "task licenses" (scripts/third-party-licenses.mjs). Do not edit by hand. -->

shoppinglist is licensed under the GNU Affero General Public License v3.0 only
(see [LICENSE](../LICENSE)). The release binary, the Docker image and the release
zip contain the third-party components below. Each keeps its own license;
all of them permit distribution as part of an AGPL-3.0 work.

What is listed is what ships, found from the build itself: the Go modules
linked into the binary (\`go list -deps\` of backend/, linux/amd64 and
linux/arm64, as GoReleaser builds it) and the npm packages whose code, styles,
fonts or images end up in the web app compiled into that binary (\`vite build\`
of frontend/). Development and test tooling is not shipped and not listed.

Components: ${goTable.length} Go, ${npmTable.length} npm, ${embTable.length} embedded in a listed package.

## Notes

- **OpenMoji** (npm \`openmoji\`): only the emoji artwork the app uses is
  embedded. It is licensed CC BY-SA 4.0 and credited in the app's settings
  footer ("Emoji: OpenMoji", with a link to the license).
- **Readex Pro** (npm \`@fontsource-variable/readex-pro\`): the font files are
  shipped unmodified under the SIL Open Font License 1.1, whose text is below.
- **SQLite** is compiled into \`modernc.org/sqlite\` and is in the public
  domain; its dedication (LICENSE-SQLITE) is reproduced below.
- **Product data and photos** that the barcode lookup fetches at run time come
  from the Open Food Facts projects (database: ODbL 1.0; photos: CC BY-SA). They
  are not part of this distribution; the app attributes them where it shows them.
  The demo build alone carries seven example products and their photos from
  Open Food Facts, listed with their sources in
  \`backend/internal/demo/products/README.md\`.
- **The Docker image's base**, \`gcr.io/distroless/static-debian13\`, carries its
  own Debian packages' copyright files under \`/usr/share/doc/*/copyright\`
  inside the image; they are not repeated here.
- The app's own icons (favicon, PWA icons) are part of shoppinglist itself.

## Go modules (linked into the binary)

${table(goTable)}

## npm packages (bundled into the web app)

${table(npmTable)}

## Embedded in a listed package

${table(embTable)}

${embTable.map((c) => `- ${c.name}: ${c.note}`).join('\n')}

## License texts

Each distinct text appears once, followed by the components it applies to.
Copyright lines are omitted from the texts and listed with each component.

${[...groups.values()]
	.sort(
		(a, b) =>
			a.kind.localeCompare(b.kind) ||
			a.members[0].c.name.localeCompare(b.members[0].c.name) ||
			a.key.localeCompare(b.key)
	)
	.map(
		(g) => `### ${g.kind}: ${g.members
			.map((m) => m.c.name)
			.filter((n, i, a) => a.indexOf(n) === i)
			.slice(0, 3)
			.join(', ')}${g.members.length > 3 ? ` and ${g.members.length - 3} more` : ''}

Applies to:

${g.members.map((m) => `- ${m.c.name} ${m.c.version} (${m.file})${m.c.copyright.length ? ': ' + m.c.copyright.join('; ') : ''}`).join('\n')}

${fence(g.body)}
`
	)
	.join('\n')}`.replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------- main

// The same components as a CycloneDX 1.6 SBOM ([D-203]): what ships, the Go
// modules linked into the binary and the npm code bundled into the web app.
// The image's own SBOM (buildkit's syft attestation) lists the Go modules and
// the base image's packages but cannot see npm code compiled into the binary;
// this one can. No timestamp or serial number, so it is deterministic and
// `--check` can hold it to the code like the licence notice.
function sbom(goComps, npmComps) {
	const purl = (c) => {
		if (c.eco === 'npm') {
			const at = c.name.startsWith('@') ? '%40' + c.name.slice(1) : c.name;
			return `pkg:npm/${at}@${c.version}`;
		}
		if (c.name.startsWith('Go standard library'))
			return `pkg:golang/stdlib@${c.version.replace(/^go/, '')}`;
		return `pkg:golang/${c.name}@${c.version}`;
	};
	const component = (c) => ({
		type: 'library',
		'bom-ref': purl(c),
		name: c.name.startsWith('Go standard library') ? 'stdlib' : c.name,
		version: c.version.replace(/^go(?=\d)/, ''),
		purl: purl(c),
		...(c.license ? { licenses: [{ expression: c.license }] } : {})
	});
	return (
		JSON.stringify(
			{
				bomFormat: 'CycloneDX',
				specVersion: '1.6',
				version: 1,
				metadata: {
					component: {
						type: 'application',
						'bom-ref': 'shoppinglist',
						name: 'shoppinglist',
						licenses: [{ expression: 'AGPL-3.0-only' }]
					}
				},
				components: [...goComps, ...npmComps].map(component)
			},
			null,
			'\t'
		) + '\n'
	);
}

const go = goComponents();
const npm = npmComponents();
const text = render(go, npm);
const bom = sbom(go, npm);
const problems = [];
for (const c of [...go, ...npm]) {
	if (!c.license) problems.push(`${c.name}@${c.version}: no recognisable licence`);
	// An SPDX expression passes when it can be met with allowed licences
	// alone; one spdx-satisfies cannot parse (a bare "GPL") cannot.
	else if (!allowedLicence(c.license))
		problems.push(`${c.name}@${c.version}: licence ${c.license} is not on the allowlist`);
	if (c.eco === 'npm' && c.detected && !c.license.includes(c.detected))
		problems.push(
			`${c.name}@${c.version}: package.json says ${c.license}, its licence file reads as ${c.detected}`
		);
	if (!c.files.length) problems.push(`${c.name}@${c.version}: ships no licence file`);
}
if (problems.length) {
	console.error('third-party-licenses: needs a look:\n  ' + problems.join('\n  '));
	process.exitCode = 1;
}
if (CHECK) {
	const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
	if (old !== text) {
		console.error(
			'third-party-licenses: docs/THIRD_PARTY_LICENSES.md is out of date — run `task licenses`'
		);
		process.exitCode = 1;
	}
	const oldBom = existsSync(SBOM_OUT) ? readFileSync(SBOM_OUT, 'utf8') : '';
	if (oldBom !== bom) {
		console.error('third-party-licenses: docs/sbom.cdx.json is out of date — run `task licenses`');
		process.exitCode = 1;
	}
} else {
	writeFileSync(OUT, text);
	writeFileSync(SBOM_OUT, bom);
	console.log(
		`wrote ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, SBOM_OUT)}: ${go.length} Go, ${npm.length} npm components`
	);
}
