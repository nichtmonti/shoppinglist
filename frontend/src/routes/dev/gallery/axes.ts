// The gallery's settings, declared once. Each axis is one control in the
// toolbar and one query parameter, so every configuration has a URL: the
// toolbar writes it as you change things, and a harness opens a configuration
// by URL instead of driving the controls (e2e/tiles/gallery.ts). A value at
// its default is left out of the URL.

import { COMPARISONS } from './comparisons';
import type { Content, KindChoice, ListState } from './fixtures';

export type Theme = 'light' | 'dark';
export type Density = 'comfortable' | 'compact' | 'list';
export type View = 'shop' | 'list';

export type Page = 'list' | 'buttons' | 'design';

export interface GalleryState {
	/** The list's states, the button family (ButtonGallery) or the design system (DesignGallery). */
	page: Page;
	/** 'none', or a COMPARISONS id. */
	compare: string;
	content: Content;
	state: ListState;
	view: View[];
	theme: Theme[];
	density: Density[];
	width: string;
	scale: string;
	locale: 'de' | 'en';
	order: 'default' | 'az' | 'category';
	kind: KindChoice;
	captions: boolean;
	outlines: boolean;
}

type Choice = readonly [value: string, label: string];
/** Where the control sits: the main row, or behind "Weitere Optionen". */
type Group = 'main' | 'more';
interface Base {
	label: string;
	group: Group;
	/** Greyed out, with its value kept, while this holds. */
	disabled?: (s: GalleryState) => boolean;
}
export type Axis =
	| (Base & { type: 'one'; choices: readonly Choice[]; default: string })
	| (Base & { type: 'many'; choices: readonly Choice[]; default: readonly string[] })
	| (Base & { type: 'flag'; default: boolean });

const px = (sizes: number[], unit: string): Choice[] => sizes.map((s) => [`${s}`, `${s}${unit}`]);
/** An axis of the list's previews, which the other pages do not draw. */
const listOnly = (s: GalleryState) => s.page !== 'list';

export const AXES = {
	page: {
		type: 'one',
		label: 'Seite',
		group: 'main',
		choices: [
			['list', 'Liste'],
			['buttons', 'Buttons'],
			['design', 'Gestaltung']
		],
		default: 'list'
	},
	compare: {
		type: 'one',
		label: 'Vergleich',
		group: 'main',
		choices: [['none', 'Nur aktuelle App'], ...COMPARISONS.map((c): Choice => [c.id, c.title])],
		default: 'none',
		disabled: listOnly
	},
	content: {
		type: 'one',
		label: 'Beispiele',
		group: 'main',
		choices: [
			['everyday', 'Gemischter Einkauf'],
			['stress', 'Alle Textfälle'],
			['photos', 'Fotos & Bildfehler']
		],
		default: 'everyday',
		disabled: listOnly
	},
	state: {
		type: 'one',
		label: 'Zustand',
		group: 'main',
		choices: [
			['normal', 'Offen'],
			['done', 'Alles erledigt'],
			['empty', 'Leere Liste'],
			['loading', 'Laden']
		],
		default: 'normal',
		disabled: listOnly
	},
	view: {
		type: 'many',
		label: 'Ansicht',
		group: 'main',
		choices: [
			['shop', 'Einkaufen'],
			['list', 'Bearbeiten']
		],
		default: ['shop', 'list'],
		disabled: listOnly
	},
	theme: {
		type: 'many',
		label: 'Thema',
		group: 'main',
		choices: [
			['light', 'Hell'],
			['dark', 'Dunkel']
		],
		default: ['light']
	},
	density: {
		type: 'many',
		label: 'Dichte',
		group: 'main',
		choices: [
			['comfortable', 'Komfortabel'],
			['compact', 'Kompakt'],
			['list', 'Liste']
		],
		default: ['comfortable'],
		disabled: listOnly
	},
	width: {
		type: 'one',
		label: 'Breite',
		group: 'main',
		choices: px([320, 360, 390, 430, 600, 768, 820], 'px'),
		default: '390'
	},
	scale: {
		type: 'one',
		label: 'Textgröße',
		group: 'main',
		choices: px([100, 150, 200], '%'),
		default: '100'
	},
	locale: {
		type: 'one',
		label: 'Sprache',
		group: 'main',
		choices: [
			['de', 'Deutsch'],
			['en', 'English']
		],
		default: 'de'
	},
	order: {
		type: 'one',
		label: 'Reihenfolge',
		group: 'more',
		choices: [
			['default', 'Standard je Ansicht'],
			['az', 'A–Z'],
			['category', 'Kategorie']
		],
		default: 'default',
		disabled: listOnly
	},
	kind: {
		type: 'one',
		label: 'Artikelart',
		group: 'more',
		choices: [
			['mixed', 'Gemischt'],
			['plain', 'Alle getippt'],
			['photo', 'Alle mit Foto'],
			['scan', 'Alle gescannt, ohne Foto'],
			['failed', 'Alle mit Bildfehler']
		],
		default: 'mixed',
		// The photo cases are about their kind; CONTENT.photos.kinds is false.
		disabled: (s) => listOnly(s) || s.content === 'photos'
	},
	captions: {
		type: 'flag',
		label: 'Fallnamen anzeigen',
		group: 'more',
		default: false,
		disabled: listOnly
	},
	outlines: {
		type: 'flag',
		label: 'Textflächen umranden',
		group: 'more',
		default: false,
		disabled: listOnly
	}
} as const satisfies Record<keyof GalleryState, Axis>;

export const AXIS_IDS = Object.keys(AXES) as (keyof GalleryState)[];

/** The state a query string describes. Unknown values fall back to the
 *  axis default, so a stale link still opens. */
export function parseState(params: URLSearchParams): GalleryState {
	const state: Record<string, unknown> = {};
	for (const id of AXIS_IDS) {
		const axis: Axis = AXES[id];
		const raw = params.get(id);
		if (axis.type === 'flag') {
			state[id] = raw === null ? axis.default : raw === '1';
		} else if (axis.type === 'one') {
			state[id] = axis.choices.some(([v]) => v === raw) ? raw : axis.default;
		} else {
			const picked = (raw ?? '').split(',').filter((v) => axis.choices.some(([c]) => c === v));
			state[id] = raw !== null && picked.length ? picked : [...axis.default];
		}
	}
	return state as unknown as GalleryState;
}

/** The query string for a state, defaults left out. */
export function toSearch(state: GalleryState): string {
	const params = new URLSearchParams();
	for (const id of AXIS_IDS) {
		const axis: Axis = AXES[id];
		const value = state[id];
		if (axis.type === 'flag') {
			if (value !== axis.default) params.set(id, value ? '1' : '0');
		} else if (axis.type === 'one') {
			if (value !== axis.default) params.set(id, value as string);
		} else {
			// Kept in the axis' own order, so one state has one URL.
			const list = axis.choices.map(([v]) => v).filter((v) => (value as string[]).includes(v));
			if (list.join(',') !== axis.default.join(',')) params.set(id, list.join(','));
		}
	}
	return params.toString();
}
