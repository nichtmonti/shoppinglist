import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { createTV } from 'tailwind-variants';

/**
 * The project's own theme scales (app.css `@theme`), which tailwind-merge
 * cannot know. Without them it reads `text-micro` as a text COLOUR, so
 * `cn('text-micro text-muted-foreground')` would drop the size, and it misses
 * real conflicts like `rounded-chip rounded-full` ([D-146]).
 * utils.test.ts fails when these lists drift from app.css.
 */
export const THEME_SCALES = {
	text: ['hero', 'meta', 'micro', 'name', 'note', 'qty', 'tile', 'title'],
	radius: ['card', 'chip', 'control'],
	'font-weight': ['book', 'demi'],
	leading: ['body', 'flush'],
	shadow: ['pop', 'sheet']
};

/** tailwind-merge, taught the project's theme — the one merge `cn` and the class-conflict check share. */
const mergeClasses = extendTailwindMerge({ extend: { theme: THEME_SCALES } });

export function cn(...inputs: ClassValue[]) {
	return mergeClasses(clsx(inputs));
}

/**
 * tailwind-variants' `tv`, on the same taught merge ([D-146]). Import `tv` from
 * here, never from 'tailwind-variants', whose stock merge has the same
 * blindness.
 */
export const tv = createTV({ twMergeConfig: { extend: { theme: THEME_SCALES } } });

/**
 * The utilities in a class list that another utility in the same list
 * overrides — i.e. the ones tailwind-merge would drop. On an element they are
 * a sheet-order lottery: which one applies depends on where Tailwind emits
 * them, not on their order in the attribute ([D-146]).
 */
export function conflictingClasses(className: string): string[] {
	const tokens = className.split(/\s+/).filter(Boolean);
	const kept = new Set(mergeClasses(tokens.join(' ')).split(/\s+/));
	return tokens.filter((t) => !kept.has(t));
}

type WithoutChildren<T> = Omit<T, 'children'>;
export type WithoutChild<T> = Omit<T, 'child'>;
export type WithoutChildrenOrChild<T> = WithoutChild<WithoutChildren<T>>;
export type WithElementRef<T, R extends HTMLElement = HTMLElement> = T & { ref?: R | null };
