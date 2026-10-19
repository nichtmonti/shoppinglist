import type { Locator, Page } from '@playwright/test';

// Opens /dev/gallery in one configuration, by URL. The gallery's settings are
// its query parameters (frontend/src/routes/dev/gallery/axes.ts), so a
// harness never drives the toolbar; it names what it wants to see and gets
// the current-app row back. Inside it, `.frame[data-view]` is one preview and
// `[data-item="<id>"]` one item's cell, its id the fixture case's (fixtures.ts).
// Comparisons are `[data-variant="<id>"]` rows (comparisons.ts).

type OneOrMany<T> = T | T[];
export interface GalleryQuery {
	/** 'none' or a comparison id from comparisons.ts. */
	compare?: string;
	content?: 'everyday' | 'stress' | 'photos';
	state?: 'normal' | 'done' | 'empty' | 'loading';
	kind?: 'mixed' | 'plain' | 'photo' | 'scan' | 'failed';
	view?: OneOrMany<'shop' | 'list'>;
	theme?: OneOrMany<'light' | 'dark'>;
	density?: OneOrMany<'comfortable' | 'compact' | 'list'>;
	width?: number;
	scale?: number;
	locale?: 'de' | 'en';
	order?: 'default' | 'az' | 'category';
	captions?: boolean;
	outlines?: boolean;
}

function param(value: string | number | boolean | string[]): string {
	if (Array.isArray(value)) return value.join(',');
	if (typeof value === 'boolean') return value ? '1' : '0';
	return `${value}`;
}

export function galleryUrl(query: GalleryQuery = {}): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query))
		if (value !== undefined) params.set(key, param(value));
	const search = params.toString();
	return `/dev/gallery${search ? `?${search}` : ''}`;
}

/** Opens the gallery and returns its current-app row. The first visit waits
 *  long: the dev server transforms the gallery's graph on demand. */
export async function openGallery(page: Page, query: GalleryQuery = {}): Promise<Locator> {
	await page.goto(galleryUrl(query));
	await page.locator('[data-gallery-ready]').waitFor({ timeout: 120_000 });
	const current = page.locator('[data-variant="current"]').first();
	await current.waitFor();
	return current;
}
