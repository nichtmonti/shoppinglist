// Which steps a browser gets ([D-231]): every browser on iOS installs through
// the share sheet, iPadOS hides behind a Mac user agent, Android goes through
// the browser menu.
import { describe, expect, it } from 'vitest';
import { detectPlatform } from './install.svelte';

const UA = {
	iphoneSafari:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
	iphoneChrome:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
	ipadDesktop:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
	androidChrome:
		'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
	androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
	samsung:
		'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
	desktopChrome:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
};

describe('detectPlatform', () => {
	it.each([
		['iPhone Safari', UA.iphoneSafari, 5, 'ios'],
		['iPhone Chrome', UA.iphoneChrome, 5, 'ios'],
		['iPad asking for the desktop site', UA.ipadDesktop, 5, 'ios'],
		['a real Mac', UA.ipadDesktop, 0, 'other'],
		['Android Chrome', UA.androidChrome, 5, 'android'],
		['Android Firefox', UA.androidFirefox, 5, 'android'],
		['Samsung Internet', UA.samsung, 5, 'android'],
		['desktop Chrome', UA.desktopChrome, 0, 'other']
	])('%s → %s', (_name, ua, touch, expected) => {
		expect(detectPlatform(ua, touch)).toBe(expected);
	});
});
