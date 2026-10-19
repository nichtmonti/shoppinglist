// applyDndAriaStrings is the ONE place the svelte-dnd-action screen-reader
// table is wired to the locale (both draggable surfaces call it from a
// $effect). A typo'd message key would not fail loudly — the library would
// silently fall back to its English defaults — so this pins the exact key
// set and the function/literal split of the mapping.
import { describe, expect, it, vi } from 'vitest';

const setAriaStrings = vi.hoisted(() => vi.fn());
const t = vi.hoisted(() => vi.fn((key: string) => `<${key}>`));

vi.mock('svelte-dnd-action', () => ({
	SHADOW_ITEM_MARKER_PROPERTY_NAME: 'isDndShadowItem',
	setAriaStrings
}));
vi.mock('#lib/i18n/index.js', () => ({ t }));

import { applyDndAriaStrings } from './dnd';

// The seven message keys the drag announcements are built from — the same
// set both components' inline copies used before the dedupe into #lib/dnd.
const CANONICAL_KEYS = [
	'categories_dnd_start',
	'categories_dnd_moved',
	'categories_dnd_moved_end',
	'categories_dnd_moved_start',
	'categories_dnd_cancel',
	'categories_dnd_instruction',
	'categories_dnd_disabled'
];

describe('applyDndAriaStrings', () => {
	it('wires every announcement through i18n with the canonical keys', () => {
		applyDndAriaStrings();

		expect(setAriaStrings).toHaveBeenCalledTimes(1);
		const strings = setAriaStrings.mock.calls[0][0] as Record<string, unknown>;

		// The two instruction strings are evaluated eagerly at apply time.
		expect(strings.zoneActiveInstruction).toBe('<categories_dnd_instruction>');
		expect(strings.zoneDragDisabledInstruction).toBe('<categories_dnd_disabled>');

		// The five lifecycle announcements are closures over t() — they must
		// translate at ANNOUNCEMENT time so a locale switch mid-session still
		// speaks the new language.
		expect(
			(strings.dragStarted as (a: { itemLabel: string; zoneLabel: string }) => string)({
				itemLabel: 'Milch',
				zoneLabel: 'Liste'
			})
		).toBe('<categories_dnd_start>');
		expect(
			(
				strings.movedToPosition as (a: {
					itemLabel: string;
					zoneLabel: string;
					position: number;
				}) => string
			)({ itemLabel: 'Milch', zoneLabel: 'Liste', position: 3 })
		).toBe('<categories_dnd_moved>');
		expect(
			(strings.movedToZoneEnd as (a: { itemLabel: string; zoneLabel: string }) => string)({
				itemLabel: 'Milch',
				zoneLabel: 'Liste'
			})
		).toBe('<categories_dnd_moved_end>');
		expect(
			(strings.movedToZoneStart as (a: { itemLabel: string; zoneLabel: string }) => string)({
				itemLabel: 'Milch',
				zoneLabel: 'Liste'
			})
		).toBe('<categories_dnd_moved_start>');
		expect((strings.dropped as (a: { itemLabel: string }) => string)({ itemLabel: 'Milch' })).toBe(
			'<categories_dnd_cancel>'
		);

		// Every t call used one of the seven canonical keys, each exactly once
		// for this apply — no typo can hide as a silent English fallback.
		expect([...t.mock.calls].map((c) => c[0]).sort()).toEqual([...CANONICAL_KEYS].sort());
	});

	it('is safe to re-apply (a locale switch re-runs the $effect)', () => {
		setAriaStrings.mockClear();
		t.mockClear();
		applyDndAriaStrings();
		applyDndAriaStrings();
		expect(setAriaStrings).toHaveBeenCalledTimes(2);
	});
});
