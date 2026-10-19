// [D-181] Every emoji the app draws as a picture has OpenMoji artwork, and the
// lookup finds it the way the build plugin picked it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import emojiSet from './emoji-set.json';
import { emojiAsset } from './emoji';
import { openmojiStems } from './emoji-stems';
import { seedTemplates } from './test-kit/seed';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const seeded = seedTemplates.map((c) => c.icon);

const openmojiDir = path.join(repo, 'frontend/node_modules/openmoji/color/svg');
const openmojiFile = (stem: string) => readFileSync(path.join(openmojiDir, `${stem}.svg`), 'utf8');

/** The SVG text inside an inlined data: URL, whichever encoding Vite chose. */
function artwork(url: string | null): string {
	const m = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(url ?? '');
	if (!m) throw new Error(`not an inlined SVG: ${String(url).slice(0, 60)}`);
	return m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
}
// Vite tidies an inlined SVG's whitespace and quotes; the drawing is the same.
const normalize = (svg: string) => svg.replace(/\s+/g, '').replace(/"/g, "'");

describe('emoji artwork', () => {
	// [D-186]: inlined, so an icon is there the moment its row renders.
	it('is inlined as the package SVG itself, not a file loaded after the row', () => {
		const url = emojiAsset('🥛');
		expect(url).toMatch(/^data:image\/svg\+xml/);
		expect(normalize(artwork(url))).toBe(normalize(openmojiFile('1F95B')));
	});

	it('exists for every picker, empty-state and seeded category emoji', () => {
		const missing = [...emojiSet.pick, ...emojiSet.decor, ...seeded].filter((e) => !emojiAsset(e));
		expect(missing).toEqual([]);
	});

	it('the seeded category icons are all offered by the picker', () => {
		expect(seeded.filter((e) => !emojiSet.pick.includes(e))).toEqual([]);
	});

	it('names files like OpenMoji: hex code points, FE0F dropped as a fallback', () => {
		expect(openmojiStems('🥛')).toEqual(['1F95B']);
		expect(openmojiStems('❄️')).toEqual(['2744-FE0F', '2744']);
		// ❄️ with and without its variation selector reach the same file.
		expect(emojiAsset('❄️')).toBe(emojiAsset('❄'));
		expect(normalize(artwork(emojiAsset('❄️')))).toBe(normalize(openmojiFile('2744')));
	});

	it('has no artwork for an emoji outside the set, so the caller shows text', () => {
		expect(emojiAsset('🦄')).toBeNull();
		expect(emojiAsset('')).toBeNull();
		expect(emojiAsset(null)).toBeNull();
	});
});
