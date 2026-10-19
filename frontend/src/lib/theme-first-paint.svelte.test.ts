// static/theme.js sets mode-watcher's `dark` class before the first paint, from
// the stored choice or, for "system", the phone's scheme, and points the
// browser bar at a stored light or dark choice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import script from '../../static/theme.js?raw';
import { followThemeChoice } from './theme-color';

const LIGHT = '#05773b';
const DARK = '#131311';

function run(stored: string | null, osDark: boolean): boolean {
	document.documentElement.classList.remove('dark');
	if (stored === null) localStorage.removeItem('mode-watcher-mode');
	else localStorage.setItem('mode-watcher-mode', stored);
	vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: osDark } as MediaQueryList);
	// eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped file as the page does
	new Function(script)();
	return document.documentElement.classList.contains('dark');
}

const bar = () =>
	[...document.head.querySelectorAll('meta[name="theme-color"]')].map((m) =>
		m.getAttribute('content')
	);

beforeEach(() => {
	document.head.innerHTML =
		`<meta name="theme-color" content="${LIGHT}" media="(prefers-color-scheme: light)" />` +
		`<meta name="theme-color" content="${DARK}" media="(prefers-color-scheme: dark)" />`;
});

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.documentElement.classList.remove('dark');
	document.head.innerHTML = '';
});

describe('static/theme.js', () => {
	it('follows the stored choice, and the phone for "system" or none', () => {
		expect(run('dark', false)).toBe(true);
		expect(run('light', true)).toBe(false);
		expect(run('system', true)).toBe(true);
		expect(run('system', false)).toBe(false);
		expect(run(null, true)).toBe(true);
	});

	it('gives the browser bar the chosen colour, and leaves it to the phone otherwise', () => {
		run('system', true);
		expect(bar()).toEqual([LIGHT, DARK]);
		run('dark', false);
		expect(bar()).toEqual([DARK, DARK]);
	});

	// The app's own code takes over from it: "System" chosen later must still
	// find each meta's own colour.
	it("leaves the shell's colours for the app to restore", () => {
		run('dark', false);
		followThemeChoice('system');
		expect(bar()).toEqual([LIGHT, DARK]);
		followThemeChoice('light');
		expect(bar()).toEqual([LIGHT, LIGHT]);
	});
});
