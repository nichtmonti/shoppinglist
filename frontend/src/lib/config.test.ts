// #lib/config — the deployment value the server stamps into the shell
// document (backend/internal/ui). The meta names come from the JSON both ends
// read, so what is worth a test here is the fallback behaviour: this module's
// whole job is to have a defined answer for a document it cannot trust — an old
// service worker's precached shell, a proxy rewrite, or an operator's typo that
// somehow got past the boot validation.
import { describe, expect, it } from 'vitest';
import {
	parseAppVersion,
	parseMaxItemsPerList,
	parseScannerEnabled,
	parseSourceUrl,
	DEFAULT_SOURCE_URL
} from './config';

describe('#lib/config app version ([D-181])', () => {
	it('reads the release as the server stamps it', () => {
		expect(parseAppVersion('v0.5.0 (abc1234)')).toBe('v0.5.0 (abc1234)');
		expect(parseAppVersion(' dev ')).toBe('dev');
	});

	it('has none without a stamp, or with an implausible one', () => {
		expect(parseAppVersion(null)).toBeNull();
		expect(parseAppVersion('')).toBeNull();
		expect(parseAppVersion('<script>')).toBeNull();
		expect(parseAppVersion('v'.repeat(65))).toBeNull();
	});
});

describe('#lib/config source link ([D-211])', () => {
	it("takes the stamped repository, else this project's", () => {
		expect(parseSourceUrl(' https://git.example.org/me/shoppinglist ')).toBe(
			'https://git.example.org/me/shoppinglist'
		);
		expect(parseSourceUrl(null)).toBe(DEFAULT_SOURCE_URL);
		expect(parseSourceUrl('')).toBe(DEFAULT_SOURCE_URL);
	});

	it('never links anything but http(s)', () => {
		expect(parseSourceUrl('javascript:alert(1)')).toBe(DEFAULT_SOURCE_URL);
		expect(parseSourceUrl('git.example.org/me')).toBe(DEFAULT_SOURCE_URL);
	});
});

describe('#lib/config items cap ([D-217])', () => {
	it('takes a stamped whole number of at least 1', () => {
		expect(parseMaxItemsPerList('300')).toBe(300);
		expect(parseMaxItemsPerList(' 1 ')).toBe(1);
	});

	it('anything else is the compiled default (null)', () => {
		for (const raw of [null, undefined, '', '0', '-5', '3.5', '300 items', 'abc']) {
			expect(parseMaxItemsPerList(raw)).toBeNull();
		}
	});
});

describe('#lib/config scanner switch ([D-218])', () => {
	it('only an explicit "off" hides the scanner', () => {
		expect(parseScannerEnabled('off')).toBe(false);
		expect(parseScannerEnabled(' OFF ')).toBe(false);
		for (const raw of [null, undefined, '', 'on', 'nope']) {
			expect(parseScannerEnabled(raw)).toBe(true);
		}
	});
});
