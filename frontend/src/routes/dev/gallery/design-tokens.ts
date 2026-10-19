// The design system as app.css states it, and where each part is used, read
// from the source, so the design page (DesignGallery) shows the system as it
// is ([D-314]). Dev only: the gallery route is never in a production build.

import type { Use } from './button-uses';

export interface Role {
	name: string;
	/** The role's comment in app.css: what carries it. */
	purpose: string;
	/** Its @apply line. */
	recipe: string;
}

export interface Tokens {
	roles: Role[];
	/** The ramp's steps beside Tailwind's sm and base: micro, note, … */
	sizes: string[];
	radii: string[];
	shadows: string[];
	/** The colour utilities' names (bg-…, text-…, border-…) and their values. */
	colors: { name: string; value: string }[];
	/** The page's layers, bottom to top: `z-(--layer-…)`. */
	layers: { name: string; value: number }[];
}

/** The type roles, ramp steps, radii and elevations declared in app.css. */
export function readTokens(css: string): Tokens {
	const roles = [
		...css.matchAll(/@utility (type-[\w-]+) \{\s*\/\*\s*([\s\S]*?)\s*\*\/\s*@apply ([^;]+);/g)
	].map(([, name, purpose, recipe]) => ({
		name,
		purpose: purpose.replace(/\s+/g, ' '),
		recipe
	}));
	const theme = /@theme inline \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
	const names = (prefix: string) =>
		[...theme.matchAll(new RegExp(`--${prefix}-([\\w-]+):`, 'g'))].map((m) => m[1]);
	return {
		roles,
		sizes: names('text').filter((n) => !n.startsWith('glyph')),
		radii: names('radius'),
		shadows: names('shadow'),
		layers: [...css.matchAll(/--(layer-[\w-]+): (\d+);/g)]
			.map(([, name, value]) => ({ name, value: Number(value) }))
			.sort((a, b) => a.value - b.value),
		colors: [...theme.matchAll(/--color-([\w-]+): ([^;]+);/g)].map(([, name, value]) => ({
			name,
			value
		}))
	};
}

/** Every use of the classes asked for, by class: a whole class under any
 *  variant, in markup, scripts or CSS (`@apply`, `var(--text-name)`), or a
 *  class constant (`cardSurface`) where it is used rather than imported. */
export function scanClasses(
	file: string,
	source: string,
	classes: string[],
	into: Map<string, Use[]>
): void {
	const lines = source.split('\n');
	const lineAt = (index: number) => source.slice(0, index).split('\n').length;
	for (const cls of classes) {
		const escaped = cls.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
		for (const m of source.matchAll(
			new RegExp(`(?<=["'\`\\s:{([,<])${escaped}(?=[/"'\`\\s});,\\]>])`, 'g')
		)) {
			const line = lineAt(m.index);
			// An import names the constant, and its own definition is not a use.
			if (/^\s*import\b/.test(lines[line - 1]) || source.endsWith('const ', m.index)) continue;
			into.set(cls, [...(into.get(cls) ?? []), { file, line }]);
		}
	}
}

export function classUses(classes: string[]): Map<string, Use[]> {
	const sources = import.meta.glob<string>(
		[
			'/src/lib/**/*.svelte',
			'/src/lib/components/**/*.ts',
			'/src/routes/**/*.svelte',
			'/src/**/*.css',
			'!/src/routes/dev/**',
			'!**/*.test.ts'
		],
		{ query: '?raw', import: 'default', eager: true }
	);
	const uses = new Map<string, Use[]>();
	for (const [path, source] of Object.entries(sources)) {
		scanClasses(path.replace('/src/', ''), source, classes, uses);
	}
	return uses;
}
