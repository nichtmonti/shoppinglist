import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Item } from '#lib/db.js';
import { AXES, AXIS_IDS, parseState, toSearch, type GalleryState } from './axes';
import { scanButtons } from './button-uses';
import { COMPARISONS } from './comparisons';
import { readTokens, scanClasses } from './design-tokens';
import { CATS, CONTENT, PHOTO_CASES, TEXT_CASES, fixtures } from './fixtures';

// The gallery's contract with its harnesses: case ids name what a finding is
// about, and the URL opens exactly the configuration it describes.

function kindOf(item: Item): string {
	if (item.image_url?.startsWith('data:image/png')) return 'failed';
	if (item.image_url) return 'photo';
	return item.barcode ? 'scan' : 'plain';
}

describe('gallery fixtures', () => {
	it('gives every case a unique kebab-case id', () => {
		const ids = [...TEXT_CASES, ...PHOTO_CASES].map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	it('files every case under a fixture category', () => {
		const cats = new Set(CATS.map((c) => c.id));
		for (const c of [...TEXT_CASES, ...PHOTO_CASES]) expect(cats).toContain(c.cat);
	});

	it('applies one kind to every text case, and leaves the photo cases their own', () => {
		const scans = fixtures('stress', 'normal', 'scan');
		expect(scans.every(({ item }) => item.barcode && !item.image_url)).toBe(true);
		const plain = fixtures('stress', 'normal', 'plain');
		expect(plain.every(({ item }) => !item.barcode && !item.image_url)).toBe(true);
		expect(fixtures('photos', 'normal', 'plain')).toEqual(fixtures('photos', 'normal', 'mixed'));
	});

	it('mixes kinds by case, not by position', () => {
		const kinds = Object.fromEntries(
			fixtures('everyday', 'normal', 'mixed').map(({ id, item }) => [id, kindOf(item)])
		);
		expect(kinds).toMatchObject({
			'two-line': 'photo',
			compound: 'scan',
			'long-note': 'failed',
			short: 'plain'
		});
	});

	it('uses the case id as the item id, the same on every call', () => {
		const first = fixtures('stress', 'normal', 'mixed').map(({ item }) => item.id);
		expect(fixtures('stress', 'normal', 'mixed').map(({ item }) => item.id)).toEqual(first);
		expect(first).toEqual(TEXT_CASES.map((c) => c.id));
	});

	it('renders the list states around the same cases', () => {
		expect(fixtures('everyday', 'empty', 'mixed')).toEqual([]);
		expect(fixtures('everyday', 'loading', 'mixed')).toEqual([]);
		const done = fixtures('everyday', 'done', 'mixed');
		expect(done).toHaveLength(CONTENT.everyday.cases.length);
		expect(done.every(({ item }) => item.checked && item.checked_at)).toBe(true);
	});
});

describe('gallery URL', () => {
	const defaults = parseState(new URLSearchParams());

	it('writes nothing for the defaults', () => {
		expect(toSearch(defaults)).toBe('');
	});

	it('round-trips a configuration on every axis', () => {
		const state: GalleryState = {
			page: 'buttons',
			compare: 'layout',
			content: 'stress',
			state: 'done',
			view: ['shop'],
			theme: ['light', 'dark'],
			density: ['compact', 'list'],
			width: '320',
			scale: '200',
			locale: 'en',
			order: 'az',
			kind: 'photo',
			captions: true,
			outlines: true
		};
		for (const id of AXIS_IDS) expect(state[id], id).not.toEqual(defaults[id]);
		const search = toSearch(state);
		expect(parseState(new URLSearchParams(search))).toEqual(state);
	});

	it('writes a list in the axis order, so one state has one URL', () => {
		expect(toSearch({ ...defaults, density: ['list', 'compact'] })).toBe('density=compact%2Clist');
	});

	it('falls back to the default for a value it does not know', () => {
		const state = parseState(new URLSearchParams('content=nope&density=nope&width=1'));
		expect(state.content).toBe(AXES.content.default);
		expect(state.density).toEqual(AXES.density.default);
		expect(state.width).toBe(AXES.width.default);
	});

	it('offers every registered comparison, and none by default', () => {
		expect(AXES.compare.choices.map(([id]) => id)).toEqual([
			'none',
			...COMPARISONS.map((c) => c.id)
		]);
		expect(defaults.compare).toBe('none');
	});
});

describe('button uses', () => {
	it('reads variant and size off a Button tag, past arrows and braces', () => {
		const uses = { variants: new Map(), sizes: new Map() };
		scanButtons(
			'x.svelte',
			[
				'<Button onclick={() => (a = b > c)} variant="outline" size="sm">A</Button>',
				"<Button variant={strong ? 'danger' : 'destructive'} size={s}>B</Button>",
				'<Button>C</Button>',
				"class={buttonVariants({ variant: 'ghost', size: 'icon' })}",
				'<Button variant="outline" {size}>E</Button>'
			].join('\n'),
			uses
		);
		expect(uses.variants.get('outline')).toEqual([
			{ file: 'x.svelte', line: 1 },
			{ file: 'x.svelte', line: 5 }
		]);
		expect(uses.sizes.get('sm')).toEqual([{ file: 'x.svelte', line: 1 }]);
		expect(uses.variants.get('danger')).toEqual([{ file: 'x.svelte', line: 2 }]);
		expect(uses.variants.get('destructive')).toEqual([{ file: 'x.svelte', line: 2 }]);
		expect(uses.sizes.get('dynamic')).toEqual([{ file: 'x.svelte', line: 2 }]);
		expect(uses.variants.get('default')).toEqual([{ file: 'x.svelte', line: 3 }]);
		expect(uses.variants.get('ghost')).toEqual([{ file: 'x.svelte', line: 4 }]);
		expect(uses.sizes.get('icon')).toEqual([{ file: 'x.svelte', line: 4 }]);
		expect(uses.sizes.get('passed-through')).toEqual([{ file: 'x.svelte', line: 5 }]);
	});
});

describe('design tokens', () => {
	it('reads the roles, ramp, radii and elevations from app.css', () => {
		const tokens = readTokens(readFileSync(new URL('../../../app.css', import.meta.url), 'utf8'));
		expect(tokens.roles.map((r) => r.name)).toEqual([
			'type-hero',
			'type-title',
			'type-heading',
			'type-section',
			'type-caption'
		]);
		expect(tokens.roles.every((r) => r.purpose && r.recipe)).toBe(true);
		expect(tokens.sizes).toContain('micro');
		expect(tokens.sizes).not.toContain('glyph');
		expect(tokens.radii).toEqual(['chip', 'control', 'card']);
		expect(tokens.shadows).toEqual(['pop', 'sheet']);
		expect(tokens.colors).toContainEqual({ name: 'primary-text', value: 'var(--primary-text)' });
		expect(tokens.colors.map((c) => c.name)).not.toContain('accent');
		expect(tokens.layers.map((l) => l.name)).toEqual(['layer-sticky', 'layer-bar', 'layer-modal']);
	});

	it('counts a whole class under any variant, and not a longer one', () => {
		const uses = new Map();
		scanClasses(
			'x.svelte',
			[
				'<p class="m-0 type-title">',
				"cn('dark:type-title', x)",
				'<p class="type-titles">',
				'<p class="bg-primary-soft/50">',
				'\tfont-size: var(--text-name);',
				"\timport { cardSurface } from './card-surface.js';",
				"<div class={[cardSurface, 'p-3']}>",
				"export const cardSurface = 'rounded-card shadow-pop';"
			].join('\n'),
			['type-title', 'bg-primary-soft', '--text-name', 'cardSurface', 'shadow-pop'],
			uses
		);
		expect(uses.get('type-title')).toEqual([
			{ file: 'x.svelte', line: 1 },
			{ file: 'x.svelte', line: 2 }
		]);
		expect(uses.get('bg-primary-soft')).toEqual([{ file: 'x.svelte', line: 4 }]);
		expect(uses.get('--text-name')).toEqual([{ file: 'x.svelte', line: 5 }]);
		expect(uses.get('cardSurface')).toEqual([{ file: 'x.svelte', line: 7 }]);
		expect(uses.get('shadow-pop')).toEqual([{ file: 'x.svelte', line: 8 }]);
	});
});
