// The browser bar follows the app's light/dark choice, and the phone's scheme
// for "System", as the shell's two metas say before any code runs.
import { beforeEach, describe, expect, it } from 'vitest';
import { followThemeChoice } from './theme-color';

const LIGHT = '#05773b';
const DARK = '#131311';
let head: HTMLElement;

beforeEach(() => {
	head = document.createElement('div');
	head.innerHTML =
		`<meta name="theme-color" content="${LIGHT}" media="(prefers-color-scheme: light)" />` +
		`<meta name="theme-color" content="${DARK}" media="(prefers-color-scheme: dark)" />`;
});

const contents = () => [...head.querySelectorAll('meta')].map((m) => m.getAttribute('content'));

describe('followThemeChoice', () => {
	it('gives both metas the chosen colour, and gives each its own back for "system"', () => {
		followThemeChoice('dark', head);
		expect(contents()).toEqual([DARK, DARK]);
		followThemeChoice('light', head);
		expect(contents()).toEqual([LIGHT, LIGHT]);
		followThemeChoice('system', head);
		expect(contents()).toEqual([LIGHT, DARK]);
	});
});
