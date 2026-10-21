// What scripts/doc-links.mjs and scripts/decisions-index.mjs both read from
// the repository's Markdown, as Codeberg (Forgejo) renders it.
import { readFileSync } from 'node:fs';

// Fenced blocks and inline code hold examples, not links.
const CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$|`[^`\n]*`/gm;
export const prose = (text) =>
	text.replace(CODE, (m) => (m.startsWith('`') && !m.startsWith('```') ? '``' : ''));

// Applies fn to the text outside fenced blocks and inline code, leaving the
// code as it is.
export const outsideCode = (text, fn) => {
	let out = '';
	let last = 0;
	for (const m of text.matchAll(CODE)) {
		out += fn(text.slice(last, m.index)) + m[0];
		last = m.index + m[0].length;
	}
	return out + fn(text.slice(last));
};

// Every run of characters that are not letters, digits or `_` becomes one dash.
export const slug = (heading) => {
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

// A file's anchors: each heading's, in order, keyed by the heading's text, and
// each `<a id="…">` written into it (the decision log's entries). Headings are
// read from the raw text, outside fences, so a code span in a heading still
// counts.
const cache = new Map();
export const headings = (file) => {
	if (!cache.has(file)) {
		const text = readFileSync(file, 'utf8');
		const seen = new Map();
		const list = [];
		let fence = false;
		for (const line of text.split('\n')) {
			if (/^(```|~~~)/.test(line)) fence = !fence;
			if (fence) continue;
			const m = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
			if (!m) continue;
			const base = slug(m[1]);
			const n = seen.get(base) ?? 0;
			seen.set(base, n + 1);
			list.push({ text: m[1], anchor: n ? `${base}-${n}` : base });
		}
		const ids = [...prose(text).matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
		cache.set(file, { list, ids });
	}
	return cache.get(file);
};
export const anchors = (file) => {
	const { list, ids } = headings(file);
	return new Set([...list.map((h) => h.anchor), ...ids]);
};

// The spec's numbered sections, §n and §n.n, each to its heading's anchor.
export const sections = (designFile) =>
	new Map(
		headings(designFile)
			.list.map((h) => [/^(\d+(?:\.\d+)*)\.?\s/.exec(h.text)?.[1], h.anchor])
			.filter(([n]) => n)
	);
