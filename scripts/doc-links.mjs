#!/usr/bin/env node
// Checks every relative link in the repository's Markdown: the file must
// exist, and an #anchor must name a heading in it. Anchors are computed the
// way Codeberg (Forgejo) computes them, which is where the docs are read:
// every run of characters that are not letters, digits or `_` becomes ONE
// dash. GitHub instead drops punctuation and keeps each space, so a heading
// like "SQLite on network storage (virtiofs/NFS)" yields `…-virtiofsnfs` on
// GitHub and `…-virtiofs-nfs` on Codeberg; a link written for one is dead on
// the other. Keep linked headings free of punctuation and both agree.
//
//   node scripts/doc-links.mjs   exit 1 and list each dead link (CI)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
// Code, config and log messages cite the docs by repo path
// (`docs/deploy-reference.md#hardening-notes`); those anchors must hold too.
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && !f.endsWith('.md') && !/\.(png|webp|jpe?g|ico|woff2?|zip|db)$/.test(f));
for (const file of tracked) {
	const abs = resolve(root, file);
	if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
	const text = readFileSync(abs, 'utf8');
	for (const [, path, anchor] of text.matchAll(/\b((?:docs\/)[\w./-]+\.md)#([\w-]+)/g)) {
		const dest = resolve(root, path);
		if (!existsSync(dest)) {
			console.log(`${file}: ${path}: no such file`);
			dead++;
		} else if (!anchors(dest).has(anchor)) {
			console.log(`${file}: ${path}#${anchor}: no such heading (Codeberg anchors)`);
			dead++;
		}
	}
}

if (dead) {
	console.log(`doc-links: ${dead} dead link(s)`);
	process.exit(1);
}
