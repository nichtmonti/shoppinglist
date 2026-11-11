// The shop tile's template contract ([D-86], [D-143]), made mechanical.
//
// The tile template (shop-tile.css, imported by app.css) is a @layer
// components block, and "a rule there OWNS
// its properties: the markup carries no utility for them" — because a Tailwind
// utility sits in a later layer and outranks the template WHATEVER the
// specificity. Broken, the contract fails silently: the template rule keeps
// its place in the sheet and simply never applies, which only the eye would
// otherwise catch.
//
// So: every template rule is read from app.css; every utility the tile really
// renders with is read from the DOM (so dynamic class strings are covered) and
// resolved through Tailwind's own compiler against the real app.css (so theme
// values and the project's @utility definitions resolve exactly as they ship);
// and no element may carry a utility that writes a property a template rule
// owns for that element.
import { render } from '@testing-library/svelte';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import { parseCss, type CssNode } from '#lib/test-kit/css.js';
import { makeItem } from '#lib/test-kit/db.js';
import type { Item } from '#lib/db.js';
import ShopTile from './ShopTile.svelte';

const FRONTEND = resolve(import.meta.dirname, '../../../..');
const APP_CSS = readFileSync(resolve(FRONTEND, 'src/app.css'), 'utf8');
const TEMPLATE_CSS = readFileSync(resolve(import.meta.dirname, 'shop-tile.css'), 'utf8');

function allDecls(node: CssNode): string[] {
	return [...node.decls.map(([p]) => p), ...node.children.flatMap(allDecls)];
}

// ---- property normalization -------------------------------------------------
// Utilities and template rules may name the same property differently: a
// shorthand vs its longhands, or a logical side vs a physical one (Tailwind's
// `mt-0` is margin-top, the template's margin-block-start). Everything is
// reduced to physical longhands, in the app's horizontal-tb / LTR base.

const SIDES = ['top', 'right', 'bottom', 'left'];
const LOGICAL: Record<string, string> = {
	'block-start': 'top',
	'block-end': 'bottom',
	'inline-start': 'left',
	'inline-end': 'right'
};

function longhands(prop: string): string[] {
	if (prop.startsWith('--')) return []; // custom properties are data, not layout
	for (const box of ['margin', 'padding', 'inset', 'scroll-margin', 'scroll-padding']) {
		const pre = box === 'inset' ? '' : `${box}-`;
		if (prop === box) return SIDES.map((s) => `${pre}${s}`);
		if (prop === `${box}-inline`) return [`${pre}left`, `${pre}right`];
		if (prop === `${box}-block`) return [`${pre}top`, `${pre}bottom`];
		for (const [logical, physical] of Object.entries(LOGICAL))
			if (prop === `${box}-${logical}`) return [`${pre}${physical}`];
	}
	const map: Record<string, string[]> = {
		overflow: ['overflow-x', 'overflow-y'],
		'overflow-inline': ['overflow-x'],
		'overflow-block': ['overflow-y'],
		'place-items': ['align-items', 'justify-items'],
		'place-self': ['align-self', 'justify-self'],
		'place-content': ['align-content', 'justify-content'],
		'max-inline-size': ['max-width'],
		'max-block-size': ['max-height'],
		'min-inline-size': ['min-width'],
		'min-block-size': ['min-height'],
		'inline-size': ['width'],
		'block-size': ['height'],
		'border-color': SIDES.map((s) => `border-${s}-color`),
		'border-width': SIDES.map((s) => `border-${s}-width`),
		'text-wrap': ['text-wrap-mode', 'text-wrap-style'],
		'white-space': ['white-space-collapse', 'text-wrap-mode'],
		background: ['background-color', 'background-image']
	};
	return map[prop] ?? [prop];
}

// ---- the template's owned properties ----------------------------------------

/** The tile parts a template rule can target, by the class that marks them. */
const ROLES = [
	'tile-check',
	'tile-info-icon',
	'tile-info',
	'tile-lead',
	'tile-cat',
	'tile-thumb',
	'tile-badge',
	'tile-fallback-icon',
	'tile-media',
	'tile-photo-fallback',
	'tile-photo',
	'tile-text',
	'tile-name',
	'tile-meta',
	'tile-note',
	'qty',
	'scrim'
];

/** Which part a selector targets: its LAST compound's part class, else the
 *  tile. A :has() argument names a part the rule only tests for, not the
 *  element it styles (`.tile:has(> .tile-check:hover)` styles the tile). */
function roleOf(selector: string): string | null {
	const compounds = selector
		.replace(/:has\([^)]*\)/g, '')
		.trim()
		.split(/\s+|\s*[>+~]\s*/);
	const last = compounds[compounds.length - 1];
	const part = ROLES.find((r) => new RegExp(`\\.${r}(?![\\w-])`).test(last));
	if (part) return part;
	return /^\.tile(?![\w-])/.test(last) ? 'tile' : null;
}

interface TemplateRule {
	selector: string;
	props: string[];
}

function templateRules(): TemplateRule[] {
	const layers = parseCss(TEMPLATE_CSS).filter((n) => n.prelude === '@layer components');
	// A @media or @container group is transparent: it conditions rules that
	// are the template's as much as any other (a hover sits in (hover: hover),
	// [D-350]; a row too narrow in a container query), so its children are
	// descended into, one level deep. Anything else would hide rules from the
	// parse below, so an at-rule left after that, or a rule with children,
	// fails loudly rather than slipping through.
	const nodes = layers
		.flatMap((l) => l.children)
		.flatMap((n) => (/^@(?:media|container)\b/.test(n.prelude) ? n.children : [n]));
	for (const n of nodes) expect(n.prelude, 'an at-rule the contract cannot read').not.toMatch(/^@/);
	const tileRules = nodes.filter((r) => r.prelude.split(',').some((s) => roleOf(s) !== null));
	for (const rule of tileRules) expect(rule.children, `nested rule in ${rule.prelude}`).toEqual([]);
	return tileRules.flatMap((rule) =>
		rule.prelude
			.split(',')
			.filter((sel) => roleOf(sel) !== null)
			.map((sel) => ({ selector: sel.trim(), props: rule.decls.flatMap(([p]) => longhands(p)) }))
	);
}

// ---- what a utility writes, per Tailwind ------------------------------------

async function loadStylesheet(id: string, base: string) {
	let path: string;
	if (id.startsWith('.')) path = resolve(base, id);
	else {
		const pkg = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
		const root = realpathSync(resolve(FRONTEND, 'node_modules', pkg));
		const pj = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
		const sub = id.slice(pkg.length);
		const exp = pj.exports?.['.' + sub];
		const file =
			typeof exp === 'string'
				? exp
				: (exp?.style ?? exp?.default ?? (sub ? `${sub.slice(1)}.css` : (pj.style ?? 'index.css')));
		path = resolve(root, file);
	}
	return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
}

/** Tailwind's own selector escaping, reproduced for lookup. */
const escapeClass = (token: string) => token.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

async function utilityProperties(tokens: string[]): Promise<Map<string, Set<string>>> {
	const compiler = await compile(APP_CSS, { base: resolve(FRONTEND, 'src'), loadStylesheet });
	const utilities = parseCss(compiler.build(tokens)).filter(
		(n) => n.prelude === '@layer utilities'
	);
	const rules = utilities.flatMap((l) => l.children);
	const out = new Map<string, Set<string>>();
	for (const token of tokens) {
		const head = `.${escapeClass(token)}`;
		const props = new Set<string>();
		for (const rule of rules) {
			const hit = rule.prelude
				.split(',')
				.some((s) => s.trim().startsWith(head) && !/[\w\\-]/.test(s.trim()[head.length] ?? ''));
			if (hit) for (const p of allDecls(rule)) for (const l of longhands(p)) props.add(l);
		}
		out.set(token, props);
	}
	return out;
}

// ---- the tiles, as they really render ----------------------------------------

const CASES: {
	label: string;
	item: Partial<Item> & { name: string };
	row: boolean;
	photoFailed?: boolean;
}[] = [];
for (const row of [false, true]) {
	CASES.push(
		{ label: 'typed', row, item: { name: 'Milch' } },
		{
			label: 'typed + note + qty',
			row,
			item: { name: 'Joghurt', note: 'griechisch', quantity: '4' }
		},
		{
			label: 'product with photo',
			row,
			item: { name: 'Nudeln', barcode: '4008400402222', image_url: '/p.png', quantity: '2' }
		},
		{
			label: 'product, photo failed',
			row,
			photoFailed: true,
			item: { name: 'Nudeln', barcode: '1', image_url: '/p.png' }
		},
		{ label: 'product, no photo', row, item: { name: 'Nudeln', barcode: '1', note: 'die dünnen' } }
	);
}

interface Part {
	label: string;
	role: string;
	tokens: string[];
	/** Template rules that match this element as rendered — the ones a utility on it would outrank. */
	matched: TemplateRule[];
}

function renderedParts(c: (typeof CASES)[number], rules: TemplateRule[]): Part[] {
	const { container, unmount } = render(ShopTile, {
		item: makeItem({ list: 'l', ...c.item }),
		row: c.row,
		photoFailed: c.photoFailed ?? false
	});
	const tile = container.querySelector<HTMLElement>('.tile')!;
	const collect = (label: string): Part[] =>
		[...container.querySelectorAll<HTMLElement>('[class]')].flatMap((el) => {
			const tokens = [...el.classList];
			const role = tokens.includes('tile') ? 'tile' : ROLES.find((r) => tokens.includes(r));
			return role
				? [{ label, role, tokens, matched: rules.filter((r) => el.matches(r.selector)) }]
				: [];
		});
	const label = `${c.label}${c.row ? ' (row)' : ''}`;
	const parts = collect(label);
	// A typed tile earns its door from a clamp MEASUREMENT happy-dom cannot make
	// (no layout), so the door state is checked by stating it: the markup's
	// classes do not depend on it, only the template's data-door rules do.
	if (!tile.hasAttribute('data-door')) {
		tile.setAttribute('data-door', '');
		parts.push(...collect(`${label} + door`));
	}
	unmount();
	return parts;
}

describe('tile template contract', () => {
	it('finds the template rules it is meant to guard', () => {
		const rules = templateRules();
		const owns = (role: string, prop: string) =>
			rules.some((r) => roleOf(r.selector) === role && r.props.includes(prop));
		// A parse that silently found nothing would pass everything below.
		expect(owns('tile', 'grid-template-areas')).toBe(true);
		expect(owns('tile-info', 'grid-area')).toBe(true);
		expect(owns('qty', 'align-self')).toBe(true);
		expect(owns('tile-meta', 'display')).toBe(true);
	});

	it('resolves utilities through the real app.css', async () => {
		const props = await utilityProperties([
			'self-center',
			'mt-0',
			'text-start',
			'hit-target',
			'truncate'
		]);
		expect([...props.get('self-center')!]).toEqual(['align-self']);
		expect([...props.get('mt-0')!]).toEqual(['margin-top']);
		expect(props.get('text-start')!.has('text-align')).toBe(true);
		expect(props.get('hit-target')!.has('position')).toBe(true); // the project's own @utility
		expect(props.get('truncate')!.has('text-wrap-mode')).toBe(true);
	});

	it('no tile part carries a utility for a property a matching template rule owns', async () => {
		const rules = templateRules();
		const rendered = CASES.flatMap((c) => renderedParts(c, rules));
		const tokens = [...new Set(rendered.flatMap((p) => p.tokens))];
		const writes = await utilityProperties(tokens);

		const breaches: string[] = [];
		for (const part of rendered) {
			for (const token of part.tokens) {
				for (const prop of writes.get(token) ?? []) {
					const rule = part.matched.find((r) => r.props.includes(prop));
					if (rule)
						breaches.push(
							`${part.label}: .${part.role} carries \`${token}\` (${prop}), owned by \`${rule.selector}\``
						);
				}
			}
		}
		expect([...new Set(breaches)]).toEqual([]);
	});
});
