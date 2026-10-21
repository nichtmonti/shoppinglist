#!/usr/bin/env node
// Checks that what the docs name exists. In the repository's Markdown: every
// relative link and <img src> (the file, and an #anchor naming a heading in
// it), and the names in inline code and fenced blocks: a repo path, a task
// after `task` or `scripts/gate.sh` (go-task's own list), a script after
// `pnpm` (in the package.json it runs in). In every tracked file: a
// `docs/….md` path and its #anchor, and a §n or §n.n naming a heading of
// docs/internals/design.md; scripts/decisions-index.mjs checks [D-nn].
//
// Anchors are computed the way Codeberg (Forgejo) computes them, which is
// where the docs are read: every run of characters that are not letters,
// digits or `_` becomes ONE dash. GitHub instead drops punctuation and keeps
// each space, so a heading like "SQLite on network storage (virtiofs/NFS)"
// yields `…-virtiofsnfs` on GitHub and `…-virtiofs-nfs` on Codeberg; a link
// written for one is dead on the other. Keep linked headings free of
// punctuation and both agree.
//
//   node scripts/doc-links.mjs   exit 1 and list each dead link or name (CI)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && !f.startsWith('docs/THIRD_PARTY_LICENSES'));

// Fenced blocks and inline code hold examples, not links.
const prose = (text) =>
	text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '``');

const slug = (heading) => {
	const text = heading
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.trim();
	let out = '';
	let dash = false;
	for (const ch of text) {
		if (/[\p{L}\p{N}_]/u.test(ch)) {
			if (dash && out) out += '-';
			dash = false;
			out += ch.toLowerCase();
		} else dash = true;
	}
	return out;
};

const anchorCache = new Map();
// Headings are read from the raw text, outside fences, so a code span in a
// heading still counts.
const anchors = (file) => {
	if (!anchorCache.has(file)) {
		const seen = new Map();
		const set = new Set();
		let fence = false;
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (/^(```|~~~)/.test(line)) fence = !fence;
			if (fence) continue;
			const m = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
			if (!m) continue;
			const base = slug(m[1]);
			const n = seen.get(base) ?? 0;
			seen.set(base, n + 1);
			set.add(n ? `${base}-${n}` : base);
		}
		anchorCache.set(file, set);
	}
	return anchorCache.get(file);
};

let dead = 0;
for (const file of files) {
	const abs = resolve(root, file);
	const text = prose(readFileSync(abs, 'utf8'));
	const targets = [
		...[...text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
		...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map((m) => m[1]),
		...[...text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1])
	];
	for (const target of targets) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:, …
		const [path, anchor] = target.split('#');
		const dest = path ? resolve(dirname(abs), decodeURIComponent(path)) : abs;
		if (!existsSync(dest)) {
			console.log(`${file}: ${target}: no such file`);
			dead++;
		} else if (
			anchor &&
			dest.endsWith('.md') &&
			statSync(dest).isFile() &&
			!anchors(dest).has(anchor)
		) {
			console.log(`${file}: ${target}: no such heading (Codeberg anchors)`);
			dead++;
		}
	}
}
// Inline code and fenced blocks name repo paths, tasks and package scripts;
// past drift was mostly such a name left behind by a rename or a removal. A
// path is checked up to its first glob or placeholder segment (`tools/<name>`
// checks `tools/`), and one git ignores is build output, absent from a fresh
// clone. A `cd dir` before `pnpm` in the same span or line says whose
// package.json; without one, the doc's own, and a doc at the root names the
// frontend's scripts in prose (`pnpm lint`), so there any package counts.
const PATH =
	/^(?:\.{1,2}\/)*(?:scripts|e2e|frontend|backend|tools|docs|\.woodpecker|\.devcontainer|\.githooks)\/\S*/;
const tasks = new Set(
	JSON.parse(
		execFileSync('task', ['--list-all', '--json', '--no-status'], { cwd: root, encoding: 'utf8' })
	).tasks.flatMap((t) => [t.name, ...t.aliases])
);
const packages = new Map(
	execFileSync('git', ['ls-files', 'package.json', '*/package.json'], {
		cwd: root,
		encoding: 'utf8'
	})
		.split('\n')
		.filter(Boolean)
		.map((f) => [
			dirname(resolve(root, f)),
			new Set(Object.keys(JSON.parse(readFileSync(resolve(root, f), 'utf8')).scripts ?? {}))
		])
);
// pnpm's own commands; `pnpm test` and `pnpm start` run a script.
const pnpmOwn = new Set(
	`add audit bin config create dedupe deploy dlx env exec fetch i import init install
	licenses link list ls outdated pack patch prune publish rebuild remove rm root setup
	store unlink update up why`.split(/\s+/)
);
// A command starts a span or line or follows ( && || ; |, maybe after VAR=value.
const COMMAND = String.raw`(?:^|[(;&|])\s*(?:\w+=\S*\s+)*`;
const TASK = new RegExp(String.raw`${COMMAND}(?:\S*/gate\.sh|task)((?:[ \t]+[^\s;&|)#]+)*)`, 'g');
const PNPM = new RegExp(
	String.raw`${COMMAND}pnpm[ \t]+(?:run[ \t]+)?([^\s;&|)#-][^\s;&|)#]*)`,
	'g'
);
const placeholder = /[*?[{<…$]|\.\.\./;
const missing = [];
for (const file of files) {
	const abs = resolve(root, file);
	const units = [];
	let fence = false;
	for (const [i, line] of readFileSync(abs, 'utf8').split('\n').entries()) {
		// A released section of the CHANGELOG names what was there then.
		if (file === 'CHANGELOG.md' && /^## (?!Unreleased)/.test(line)) break;
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		else if (fence) units.push([i + 1, line.replace(/(^|\s)#.*/, '')]);
		else for (const [, code] of line.matchAll(/`([^`]+)`/g)) units.push([i + 1, code]);
	}
	for (const [n, code] of units) {
		const at = `${file}:${n}`;
		for (const word of code.split(/[\s()=,;'"]+/)) {
			const m = PATH.exec(word);
			if (!m) continue;
			const name = m[0].replace(/(?::\d+(?:-\d+)?)?[.,:;)\]]*$/, '');
			const [path, anchor] = name.split('#');
			const segments = path.split('/');
			const cut = segments.findIndex((s) => placeholder.test(s));
			const literal = (cut < 0 ? segments : segments.slice(0, cut)).join('/');
			const dest = resolve(/^\.{1,2}\//.test(literal) ? dirname(abs) : root, literal);
			if (!existsSync(dest)) missing.push([at, name, relative(root, dest)]);
			else if (cut < 0 && anchor && dest.endsWith('.md') && !anchors(dest).has(anchor)) {
				console.log(`${at}: ${name}: no such heading (Codeberg anchors)`);
				dead++;
			}
		}
		for (const [, args] of code.matchAll(TASK)) {
			for (const arg of args.trim().split(/\s+/)) {
				if (arg === '--') break;
				if (!arg || arg.startsWith('-') || arg.includes('=') || placeholder.test(arg)) continue;
				if (!tasks.has(arg)) {
					console.log(`${at}: task ${arg}: Taskfile.yml has no such task`);
					dead++;
				}
			}
		}
		for (const m of code.matchAll(PNPM)) {
			const name = m[1];
			if (pnpmOwn.has(name) || placeholder.test(name)) continue;
			const cd = [...code.slice(0, m.index).matchAll(/\bcd[ \t]+([^\s;&|)]+)/g)].at(-1);
			let dir = cd ? resolve(dirname(abs), cd[1]) : dirname(abs);
			while (!packages.has(dir) && dir !== root) dir = dirname(dir);
			const any = !cd && dir === root;
			const have = any
				? [...packages.values()].some((s) => s.has(name))
				: packages.get(dir)?.has(name);
			if (!have) {
				const where = any ? 'any' : `${relative(root, dir)}/`;
				console.log(`${at}: pnpm ${name}: no such script in ${where}package.json`);
				dead++;
			}
		}
	}
}
if (missing.length) {
	const ignored = new Set(
		execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
			cwd: root,
			encoding: 'utf8',
			input: missing.flatMap(([, , path]) => [path, `${path}/`]).join('\n')
		}).split('\n')
	);
	for (const [at, name, path] of missing) {
		if (ignored.has(path) || ignored.has(`${path}/`)) continue;
		console.log(`${at}: ${name}: no such file`);
		dead++;
	}
}

// A §n or §n.n citation, in the docs or the code, names a numbered heading
// of the spec.
const sections = new Set(
	[
		...readFileSync(resolve(root, 'docs/internals/design.md'), 'utf8').matchAll(
			/^#{1,6}\s+(\d+(?:\.\d+)*)/gm
		)
	].map((m) => m[1])
);
const cited = execFileSync('git', ['grep', '-IonE', String.raw`§[0-9]+(\.[0-9]+)*`], {
	cwd: root,
	encoding: 'utf8'
});
for (const line of cited.split('\n').filter(Boolean)) {
	const [, at, section] = /^(.*):§(.*)$/.exec(line);
	if (!sections.has(section)) {
		console.log(`${at}: §${section}: docs/internals/design.md has no such section`);
		dead++;
	}
}

// Code, config and log messages cite the docs by repo path
// (`docs/deploy-reference.md#hardening-notes`); the file and an anchor must
// hold too.
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && !f.endsWith('.md') && !/\.(png|webp|jpe?g|ico|woff2?|zip|db)$/.test(f));
for (const file of tracked) {
	const abs = resolve(root, file);
	if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
	const text = readFileSync(abs, 'utf8');
	for (const [, path, anchor] of text.matchAll(/(?<![\w./-])(docs\/[\w./-]+\.md)(?:#([\w-]+))?/g)) {
		const dest = resolve(root, path);
		if (!existsSync(dest)) {
			console.log(`${file}: ${path}: no such file`);
			dead++;
		} else if (anchor && !anchors(dest).has(anchor)) {
			console.log(`${file}: ${path}#${anchor}: no such heading (Codeberg anchors)`);
			dead++;
		}
	}
}

if (dead) {
	console.log(`doc-links: ${dead} dead link(s) or name(s)`);
	process.exit(1);
}
