// §12.2's fallback for a user who has never chosen a language: the browser's
// own preference when the app speaks it, else English.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLocale } from './index';

function setBrowserLanguage(tag: string): void {
	vi.stubGlobal('navigator', { language: tag });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('detectLocale', () => {
	it.each([
		['de', 'de'],
		['de-DE', 'de'],
		['de-AT', 'de'],
		['en', 'en'],
		['en-GB', 'en'],
		['EN-US', 'en']
	])('maps a browser asking for %s to %s', (tag, want) => {
		setBrowserLanguage(tag);
		expect(detectLocale()).toBe(want);
	});

	it('falls back to en for a language the app does not speak', () => {
		setBrowserLanguage('ja-JP');
		expect(detectLocale()).toBe('en');
	});

	it('falls back to en when the browser reports nothing', () => {
		vi.stubGlobal('navigator', {});
		expect(detectLocale()).toBe('en');
	});
});
