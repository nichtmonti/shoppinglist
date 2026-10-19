// [D-180] A category's icon is drawn in one place, so the same aisle looks the
// same in the shop view, the list, the typeahead and the editor. This keeps a
// component from interpolating `{category.icon}` itself, at its own size:
// anything that shows a category's icon renders CategoryIcon.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FALLBACK_ICON, GLYPH_RATIO } from './CategoryIcon.svelte';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) return svelteFiles(full);
		return name.endsWith('.svelte') ? [full] : [];
	});
}

describe('CategoryIcon', () => {
	it('is the only component that interpolates a category icon as text', () => {
		// `{cat.icon}`, `{category?.icon ?? '📦'}` — text interpolation of an
		// `.icon` field. Not an attribute value (`icon={cat.icon}`, which is how
		// CategoryIcon is handed one), and not `<o.icon …>` (a Lucide component).
		const pattern = /(?<!=)\{\s*[\w$]+(?:\?\.|\.)icon\s*(?:\?\?[^}]*)?\}/;
		const offenders = svelteFiles(src)
			.filter((f) => !f.endsWith(path.join('common', 'CategoryIcon.svelte')))
			.filter((f) => pattern.test(readFileSync(f, 'utf8')))
			.map((f) => path.relative(src, f));
		expect(offenders).toEqual([]);
	});

	it('fills three quarters of its chip, and has one fallback', () => {
		expect(GLYPH_RATIO).toBe(0.75);
		expect(FALLBACK_ICON).toBe('📦');
	});
});
