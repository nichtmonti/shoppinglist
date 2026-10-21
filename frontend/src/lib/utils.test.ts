// [D-146]: `cn` merges classes with tailwind-merge taught the project's theme.
// A theme token tailwind-merge does not know is misclassified at RUNTIME —
// `text-micro` was read as a colour and dropped next to `text-muted-foreground`
// — so the taught scales must track app.css exactly.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cn, conflictingClasses, THEME_SCALES, tv } from './utils';

const APP_CSS = readFileSync(resolve(import.meta.dirname, '../app.css'), 'utf8');

/** Tailwind's own scale names, which tailwind-merge already knows. */
const STOCK: Record<keyof typeof THEME_SCALES, RegExp> = {
	text: /^(xs|sm|base|lg|[2-9]?xl)$/,
	radius: /^(xs|sm|md|lg|[2-4]?xl|none|full)$/,
	'font-weight': /^(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/,
	leading: /^(none|tight|snug|normal|relaxed|loose|\d+)$/,
	shadow: /^(2xs|xs|sm|md|lg|xl|2xl|none|inner)$/
};

function declaredNames(scale: keyof typeof THEME_SCALES): string[] {
	const names = [...APP_CSS.matchAll(new RegExp(`--${scale}-([a-z0-9-]+)\\s*:`, 'g'))]
		.map((m) => m[1])
		.filter((n) => !n.includes('--')); // `--text-x--line-height` companions
	return [...new Set(names)].filter((n) => !STOCK[scale].test(n)).sort();
}

describe('cn: tailwind-merge knows the project theme', () => {
	for (const scale of Object.keys(THEME_SCALES) as (keyof typeof THEME_SCALES)[]) {
		it(`teaches every custom --${scale}-* token in app.css`, () => {
			expect([...THEME_SCALES[scale]].sort()).toEqual(declaredNames(scale));
		});
	}

	it('reads a theme shadow as a shadow, not a shadow colour', () => {
		expect(cn('shadow-pop shadow-none')).toBe('shadow-none');
		expect(cn('shadow-pop shadow-black/10')).toBe('shadow-pop shadow-black/10');
	});

	it('keeps a custom text size next to a text colour', () => {
		expect(cn('text-micro text-muted-foreground')).toBe('text-micro text-muted-foreground');
	});

	it('resolves real conflicts on the custom scales', () => {
		expect(cn('rounded-chip rounded-full')).toBe('rounded-full');
		expect(cn('font-demi font-bold')).toBe('font-bold');
	});
});

describe('tv: tailwind-variants on the same merge', () => {
	it("keeps a variant's custom text size next to the base colour", () => {
		const chip = tv({ base: 'text-muted-foreground', variants: { v: { chips: 'text-meta' } } });
		expect(chip({ v: 'chips' }).split(' ').sort()).toEqual(['text-meta', 'text-muted-foreground']);
	});
});

describe('conflictingClasses', () => {
	it('names the utilities another one in the list overrides', () => {
		expect(conflictingClasses('tile relative absolute size-7.5')).toEqual(['relative']);
		expect(conflictingClasses('text-micro text-muted-foreground font-demi')).toEqual([]);
	});
});
