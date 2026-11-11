import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { PALETTE } from './categories';
import { parseCss, type CssNode } from './test-kit/css';

// AA conformance for the tint recipes that axe cannot see: every failing pair
// here involves a background built from CSS custom properties + color-mix,
// which axe's color-contrast rule reports as "incomplete" — the e2e axe walk
// passed while the aisle count pill sat at 3.64:1. This test computes the same
// recipes from app.css itself (parsed, not duplicated) so token drift fails CI.

// ---- WCAG relative luminance / contrast, over sRGB hex triplets ----
type RGB = readonly [number, number, number];

const hex = (h: string): RGB => {
	const n = h.replace('#', '');
	return [
		parseInt(n.slice(0, 2), 16),
		parseInt(n.slice(2, 4), 16),
		parseInt(n.slice(4, 6), 16)
	] as const;
};
const mix = (fg: RGB, bg: RGB, pct: number): RGB =>
	[0, 1, 2].map((i) => fg[i] * pct + bg[i] * (1 - pct)) as unknown as RGB;
const lum = (c: RGB): number => {
	const f = (v: number) => {
		v /= 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: RGB, b: RGB): number => {
	const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
};

// ---- token extraction: light block first, `.dark` block second ----
const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

// Pull each theme's declarations by slicing on :root/.dark.
function themeTokens(which: 'light' | 'dark'): Record<string, string> {
	const start = which === 'light' ? css.indexOf(':root {') : css.indexOf('.dark {');
	const end = css.indexOf('}', start);
	const block = css.slice(start, end);
	const decls = block.match(/--[\w-]+:\s*#[0-9a-fA-F]{6}/g) ?? [];
	const out: Record<string, string> = {};
	for (const d of decls) {
		const [k, v] = d.split(/:\s*/);
		out[k] = v;
	}
	// One level of alias (`--icon-plate: var(--surface-2)`),
	// resolved within the same theme: a role token that points at a
	// different base per theme ([D-114]) is then tested as what it renders.
	for (const [, k, target] of block.matchAll(/(--[\w-]+):\s*var\((--[\w-]+)\)\s*;/g)) {
		if (!(k in out) && target in out) out[k] = out[target];
	}
	return out;
}

// §9.1's horizontal rhythm, as VALUES this time rather than contrast: the list
// surfaces share one gutter, and the aisle header's 2px offset from it is a
// design decision ([D-129] — it keeps the tinted band from reading as one more
// row) that had been sitting in the markup as px-4.5 against px-4, which is
// indistinguishable from a typo. Pinned here so the relationship survives: a
// future edit may MOVE the gutter, but the header must keep deriving from it.
describe('the list gutter and the aisle header that steps inside it ([D-129])', () => {
	const decl = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
	const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

	it('states the gutter once, in px', () => {
		expect(decl('row-gutter')).toMatch(/^\d+px$/);
	});

	it('derives the header gutter from it, so the two cannot drift apart', () => {
		expect(decl('aisle-head-gutter')).toBe('calc(var(--row-gutter) + var(--aisle-head-nudge))');
		expect(decl('aisle-head-nudge')).toBe('2px');
	});

	it('derives the chip-row hairline inset from it too', () => {
		expect(decl('row-rule-inset')).toContain('var(--row-gutter)');
	});

	it('is what the row, a settings row (the door too) and the header actually use', () => {
		const row = read('./components/list/ListRow.svelte');
		const door = read('./components/settings/SettingsRow.svelte');
		const head = read('./components/common/AisleHeader.svelte');
		expect(row).toContain('px-(--row-gutter)');
		// the chip-less mode's rule starts on the same column as the content
		expect(row).toContain('after:start-(--row-gutter)');
		expect(door).toContain('px-(--row-gutter)');
		expect(head).toContain('px-(--aisle-head-gutter)');
		// no bare px-4 / px-4.5 left in the markup to contradict them
		expect(head).not.toMatch(/class=[^>]*\bpx-4\.5\b/);
		expect(row).not.toMatch(/class=[^>]*\bpx-4\b/);
		expect(door).not.toMatch(/class=[^>]*\bpx-4\b/);
	});
});

// §9.1's vertical stacking, pinned for the same reason as the gutter above: it
// is a RELATIONSHIP between two files that neither file can state on its own.
// .addwrap is `sticky` with a z-index, which makes it a stacking context — so
// the dropdown's own z-index is local to the wrap and only the WRAP's layer is
// comparable with the aisle header's. It sat at 4 against the header's 5, and
// the header (which sticks at exactly `top: var(--addbar-h)`, the dropdown's
// top edge) painted over the first suggestion and swallowed its tap ([D-131]).
describe('the add-bar dropdown outranks the aisle headers it floats over ([D-131])', () => {
	const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
	// Scoped to the class ATTRIBUTE that carries the class (a string or a
	// list), so the prose above each of these (which names both the classes
	// and the layers) cannot answer for the markup.
	const layerOf = (src: string, cls: string) => {
		const attr = new RegExp(`class=(?:"[^"]*|\\{[^}]*)\\b${cls}\\b[^"}]*`).exec(src)?.[0] ?? '';
		// A page layer is named in app.css ([D-317]); read what it stands for.
		const z = /\bz-(?:(\d+)\b|\(--([\w-]+)\))/.exec(attr);
		const layer = z?.[2] && css.match(new RegExp(`--${z[2]}:\\s*(\\d+);`))?.[1];
		return Number(z?.[1] ?? layer ?? NaN);
	};

	const bar = read('./components/add/AddBar.svelte');
	// The dropdown is drawn by SuggestionList, inside the wrap's slot.
	const list = read('./components/add/SuggestionList.svelte');
	const head = read('./components/common/AisleHeader.svelte');

	it('puts the sticky wrap — the stacking context — above the header', () => {
		expect(layerOf(bar, 'addwrap')).toBeGreaterThan(layerOf(head, 'cat-head'));
	});

	it("orders the wrap's own children scrim < field < dropdown", () => {
		const scrim = layerOf(bar, 'ta-scrim');
		const field = layerOf(bar, 'add-field');
		const drop = layerOf(list, 'ta-drop');
		expect(scrim).toBeLessThan(field);
		expect(field).toBeLessThan(drop);
	});

	// The bar around the field takes no layer: positioned with z-index auto, it
	// paints below the scrim, so the scrim dims it and only the field, with
	// the scan button inside it ([D-277]), stays lit ([D-131]).
	it('leaves the bar itself under the scrim', () => {
		expect(layerOf(bar, 'addbar')).toBeNaN();
	});
});

describe('design tokens meet WCAG AA where they are used as text', () => {
	for (const theme of ['light', 'dark'] as const) {
		const t = themeTokens(theme);
		const fg = hex(t['--foreground']);
		const surface = hex(t['--surface']);
		const surface2 = hex(t['--surface-2']);

		// [D-114]: filled selections and green hover fills are shared by the
		// home, list and settings controls. Include secondary copy on a hovered
		// card: a pair that passes on white can fail on the green tint.
		for (const [label, text, background] of [
			['selected control', '--primary-foreground', '--primary'],
			['primary button hover', '--primary-foreground', '--primary-press'],
			// [D-281]: a chosen option, the soft green with green text.
			['chosen option', '--primary-text', '--primary-soft'],
			// [D-114]: the primary as text and lines on the page's own surfaces.
			['primary as text on surface', '--primary-text', '--surface'],
			['primary as text on raised surface', '--primary-text', '--surface-2'],
			['primary as text on page', '--primary-text', '--background'],
			['secondary text on hover', '--muted-foreground', '--primary-soft'],
			['secondary text on page', '--muted-foreground', '--background']
		]) {
			it(`${theme}: ${label} ≥ 4.5`, () => {
				expect(contrast(hex(t[text]), hex(t[background]))).toBeGreaterThanOrEqual(4.5);
			});
		}

		it(`${theme}: aisle count pill (cat-text-65 on cat-surface-14 over the row's cat-surface-12) ≥ 4.5 for all categories`, () => {
			const worst: [string, number][] = [];
			for (const c of PALETTE) {
				const cat = hex(t[`--cat-${c}`]);
				const rowBg = mix(cat, surface, 0.12);
				const pillBg = mix(cat, rowBg, 0.14);
				const text = mix(cat, fg, 0.65);
				worst.push([c, contrast(text, pillBg)]);
			}
			const fails = worst.filter(([, r]) => r < 4.5);
			expect(
				fails.map(([c, r]) => `${c} ${r.toFixed(2)}`).join(', '),
				`count pill ratios: ${worst.map(([c, r]) => `${c} ${r.toFixed(2)}`).join(', ')}`
			).toBe('');
		});

		it(`${theme}: aisle name (cat-text-70 on cat-surface-12) ≥ 4.5 for all categories`, () => {
			const fails: string[] = [];
			for (const c of PALETTE) {
				const cat = hex(t[`--cat-${c}`]);
				const rowBg = mix(cat, surface, 0.12);
				const text = mix(cat, fg, 0.7);
				const r = contrast(text, rowBg);
				if (r < 4.5) fails.push(`${c} ${r.toFixed(2)}`);
			}
			expect(fails.join(', ')).toBe('');
		});

		// [D-102]: amber is pending's alone; expired uses the destructive pair
		// below (the count glyph sits on the same amber fill).
		it(`${theme}: sync banner pending (amber on amber-soft) ≥ 4.5`, () => {
			const r = contrast(hex(t['--amber']), hex(t['--amber-soft']));
			expect(r).toBeGreaterThanOrEqual(4.5);
		});

		// [D-102]: the expired chip is FILLED destructive with its own
		// foreground — the one actionable sync state is the only filled chip,
		// so its text pair is pinned like every other recipe.
		it(`${theme}: sync banner expired (destructive-foreground on destructive) ≥ 4.5`, () => {
			const r = contrast(hex(t['--danger-foreground']), hex(t['--danger']));
			expect(r).toBeGreaterThanOrEqual(4.5);
		});

		// The home card's unsynced badge wears the same amber-on-soft fill as
		// the sync chip (ListSummary) — pinned here so it can never regress
		// to bare amber on card, whose contrast this file does not cover.
		it(`${theme}: home unsynced badge (amber on amber-soft) ≥ 4.5`, () => {
			const r = contrast(hex(t['--amber']), hex(t['--amber-soft']));
			expect(r).toBeGreaterThanOrEqual(4.5);
		});

		// The sonner undo pill is the thinnest passing pair in the app (light:
		// 4.63) — pinned here because its fade-in composites toward the page
		// behind it, so any headroom loss flips it below AA in motion.
		it(`${theme}: toast undo pill (primary-text on accent-soft) ≥ 4.5`, () => {
			expect(contrast(hex(t['--primary-text']), hex(t['--primary-soft']))).toBeGreaterThanOrEqual(
				4.5
			);
		});

		it(`${theme}: danger actions (danger on danger-soft over surface) ≥ 4.5`, () => {
			const soft = mix(hex(t['--danger']), surface, 0.1);
			expect(contrast(hex(t['--danger']), soft)).toBeGreaterThanOrEqual(4.5);
		});

		it(`${theme}: shop tile quantity (muted-foreground on its 12% chip over surface-2) ≥ 4.5`, () => {
			const mf = hex(t['--muted-foreground']);
			const bg = mix(mf, surface2, 0.12);
			expect(contrast(mf, bg)).toBeGreaterThanOrEqual(4.5);
		});
	}
});

// ---- --faint is for icons and glyphs, never for text ([D-213]) -------------
//
// The 2026-10 shopping-flow audit found --faint at 2.9:1 on the page, used as
// the text of previous-item notes and dates, the offline hint and three more
// labels. Text moved to --muted-foreground; --faint keeps the decorative
// glyphs (chevrons, grips, the suppress ✕) and is held to the non-text 3:1
// (WCAG 1.4.11) on every surface it can sit on. The source scan keeps it
// there: a `text-faint` element has to be aria-hidden, i.e. a picture.
describe('--faint stays a glyph colour ([D-213])', () => {
	for (const theme of ['light', 'dark'] as const) {
		const t = themeTokens(theme);
		for (const bg of ['--background', '--surface', '--surface-2']) {
			it(`${theme}: --faint on ${bg} ≥ 3`, () => {
				expect(contrast(hex(t['--faint']), hex(t[bg]))).toBeGreaterThanOrEqual(3);
			});
		}
	}

	it('colours no text: every text-faint element is aria-hidden', () => {
		const root = new URL('../', import.meta.url);
		const files = (readdirSync(root, { recursive: true }) as string[]).filter(
			(f) => f.endsWith('.svelte') && !f.startsWith('routes/dev/')
		);
		const offenders: string[] = [];
		for (const file of files) {
			const src = readFileSync(new URL(file, root), 'utf8');
			if (src.includes('placeholder:text-faint')) offenders.push(`${file}: placeholder`);
			for (const m of src.matchAll(/\btext-faint\b/g)) {
				const tag = openingTagAround(src, m.index);
				if (!/aria-hidden="true"/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 60)}…`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

// ---- photo-tile text over its scrim ([D-213], [D-83]) ---------------------
//
// Axe reports text over a gradient as "incomplete", so the photo tile's white
// name, its note and its quantity chip were never checked. The scrim is
// anchored to the text: darkest at the foot (--tile-scrim-foot), then
// --tile-scrim-chip at the chip line's top (2.25rem, every density), then
// --tile-scrim-text at the measured top of the text block, fading out above
// it (shop-tile.css). Each band is checked where its scrim is thinnest, over
// a white photo, the worst packaging there is. The text shadow helps further
// but is not counted.
describe('photo-tile text stays legible on a white photo ([D-213], [D-83])', () => {
	const alphaOf = (name: string, rgb: string): number =>
		Number(css.match(new RegExp(`${name}:\\s*rgba\\(${rgb}, ([\\d.]+)\\)`))?.[1]);
	const chipAlpha = alphaOf('--tile-scrim-chip', '0, 0, 0');
	const textAlpha = alphaOf('--tile-scrim-text', '0, 0, 0');
	const white = hex('#ffffff');
	const black = hex('#000000');
	const shaded = (alpha: number): RGB => mix(black, white, alpha);
	const CHIP_TOP = 2.25; // rem: the stop in shop-tile.css

	it('reads the scrim alphas from app.css', () => {
		expect(chipAlpha).toBeGreaterThan(0);
		expect(textAlpha).toBeGreaterThan(0);
		expect(chipAlpha).toBeGreaterThanOrEqual(textAlpha);
	});

	it('the name (white) at the top of the text block ≥ 4.5', () => {
		expect(contrast(white, shaded(textAlpha))).toBeGreaterThanOrEqual(4.5);
	});

	it('the note (--tile-photo-note) at its top, with the least text above it ≥ 4.5', () => {
		// The note's top is ≥ 3rem up; the scrim there is thinnest when the
		// text block above it is as short as it gets — one 14px name line
		// (1.05rem) — so the text stop sits closest above the note.
		const noteTop = 3;
		const textTop = noteTop + 1.05;
		const alpha =
			chipAlpha + ((textAlpha - chipAlpha) * (noteTop - CHIP_TOP)) / (textTop - CHIP_TOP);
		const bg = shaded(alpha);
		const note = mix(white, bg, alphaOf('--tile-photo-note', '255, 255, 255'));
		expect(contrast(note, bg)).toBeGreaterThanOrEqual(4.5);
	});

	it('the quantity chip (white on --tile-photo-chip-bg) at the chip line’s top ≥ 4.5', () => {
		const chip = mix(white, shaded(chipAlpha), alphaOf('--tile-photo-chip-bg', '255, 255, 255'));
		expect(contrast(white, chip)).toBeGreaterThanOrEqual(4.5);
	});

	it('anchors the gradient in shop-tile.css to the measured text top', () => {
		const tileCss = readFileSync(
			new URL('./components/shop/shop-tile.css', import.meta.url),
			'utf8'
		);
		expect(tileCss).toMatch(/var\(--tile-scrim-chip\) 2\.25rem/);
		expect(tileCss).toMatch(/var\(--tile-scrim-text\) var\(--scrim-text-at\)/);
		expect(tileCss).toMatch(/--scrim-text-at: max\(2\.5rem, var\(--tile-text-top/);
	});
});

/** The whole opening tag a class token sits in. Brace-aware, because a
 *  handler's `=>` would end a naive `[^>]*` match mid-tag. */
function openingTagAround(src: string, at: number): string {
	const start = src.lastIndexOf('<', at);
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') depth--;
		else if (c === '>' && depth === 0) return src.slice(start, i + 1);
	}
	return src.slice(start);
}

// ---- density blocks: one complete token set per density --------------------
//
// [D-83] delivers density as root-level custom-property overrides, with
// attribute-only selectors (`[data-density='x']`, not
// `:root[data-density='x']`) so a SUBTREE can opt in — that is how
// /dev/gallery renders the densities side by side. Opting in only works
// for a density that HAS a block: a density whose values sat only in the plain
// `:root` block would match no rule in a subtree and inherit whatever the ROOT
// carried, so with the app's own preference on compact the gallery's panels
// would render identically. The invariant: the blocks declare the SAME
// set of tokens, so no density can fall through to another's value.
const DENSITIES = ['comfortable', 'compact', 'list'] as const;

// The density blocks live beside the shop grid they size (shop-layout.css).
// Comments are stripped first: several carry a `--token` name in prose, and one
// carries a `;`, both of which would otherwise land in the declaration match.
const cssBare = readFileSync(
	new URL('./components/shop/shop-layout.css', import.meta.url),
	'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

// Returns {} when the density has no block at all, so that shows up as a
// failing assertion, not a collection error.
function densityBlock(density: string): Record<string, string> {
	const at = cssBare.indexOf(`[data-density='${density}']`);
	if (at < 0) return {};
	const open = cssBare.indexOf('{', at);
	const body = cssBare.slice(open + 1, cssBare.indexOf('}', open));
	return Object.fromEntries(
		[...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
	);
}

describe('shop-grid density ([D-83])', () => {
	const blocks = Object.fromEntries(DENSITIES.map((d) => [d, densityBlock(d)]));
	const switched = [...new Set(DENSITIES.flatMap((d) => Object.keys(blocks[d])))].sort();

	for (const d of DENSITIES) {
		it(`${d} has a [data-density] block of its own`, () => {
			// Every density, comfortable included, needs a selector of its own.
			expect(Object.keys(blocks[d]).length).toBeGreaterThan(0);
		});
	}

	for (const d of DENSITIES) {
		it(`${d} declares every density-switched token, so no subtree inherits another density`, () => {
			expect(Object.keys(blocks[d]).sort()).toEqual(switched);
		});
	}

	it('the comfortable block is shared with :root, not duplicated', () => {
		// :root stays the no-attribute fallback (first paint, before the shell's
		// $effect stamps the attribute) — as the SAME rule, so the two can never
		// disagree about what comfortable is.
		expect(cssBare).toMatch(/:root,\s*\[data-density='comfortable'\]\s*{/);
	});

	// A 104 → 76 → 52 ladder at the default root size, expressed in rem
	// since [D-83] so the tile FOLLOWS the user's font size instead of
	// shrinking its text to fit a fixed box.
	it('the tile height steps 104 → 76 → 52 ([D-83]: floor; [D-313]: row)', () => {
		expect(DENSITIES.map((d) => blocks[d]['--tile-h'])).toEqual(['6.5rem', '4.75rem', '3.25rem']);
		expect(DENSITIES.map((d) => parseFloat(blocks[d]['--tile-h']) * 16)).toEqual([104, 76, 52]);
	});
});

// ---- hover rules: a device that can hover ([D-350]) ------------------------
//
// Tailwind's `hover:` variant sits in @media (hover: hover), so it cannot
// fire under a finger — but a tap does fire a raw `:hover`, and iOS Safari
// keeps it on the last-tapped element until the next tap. A hand-written
// `:hover` rule outside that media block is a sticky highlight on a phone,
// so every one the app ships, in a stylesheet or a component's <style>, must
// sit inside it. (An arbitrary `[&:hover]:` variant is lint's to refuse.)
describe('hover rules apply only where the device can hover ([D-350])', () => {
	it('every :hover rule in the app’s own CSS sits in (hover: hover)', () => {
		const root = new URL('../', import.meta.url);
		const sources = (readdirSync(root, { recursive: true }) as string[]).flatMap((file) => {
			if (file.endsWith('.css')) return [{ file, css: readFileSync(new URL(file, root), 'utf8') }];
			if (!file.endsWith('.svelte')) return [];
			const text = readFileSync(new URL(file, root), 'utf8');
			return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
				file,
				css: m[1]
			}));
		});
		expect(sources.some((s) => s.file.endsWith('.svelte'))).toBe(true);
		const canHover = /\(\s*hover\s*:\s*hover\s*\)/;
		const offenders: string[] = [];
		const walk = (file: string, nodes: CssNode[], gated: boolean) => {
			for (const n of nodes) {
				if (!gated && !n.prelude.startsWith('@') && n.prelude.includes(':hover'))
					offenders.push(`${file}: ${n.prelude}`);
				walk(
					file,
					n.children,
					gated || (n.prelude.startsWith('@media') && canHover.test(n.prelude))
				);
			}
		};
		for (const { file, css } of sources) walk(file, parseCss(css), false);
		expect(offenders).toEqual([]);
	});
});
