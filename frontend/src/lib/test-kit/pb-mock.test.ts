// The other half of pb-mock.ts ([D-77]): this FAILS when `#lib/pb.js` grows an
// export `pbModuleMock` does not cover. The remedy is adding it there.
import { describe, expect, it } from 'vitest';
import * as realPb from '#lib/pb.js';
import { pbModuleMock } from './pb-mock';

describe('pbModuleMock covers the real module', () => {
	it('defines every runtime export of #lib/pb', () => {
		const mock = pbModuleMock();
		const missing = Object.keys(realPb).filter((key) => !(key in mock));
		expect(missing).toEqual([]);
	});

	it('answers only the collections a test names', () => {
		const accounts = {};
		const { pb } = pbModuleMock({ collections: { accounts } }) as {
			pb: { collection: (name: string) => object };
		};
		expect(pb.collection('accounts')).toBe(accounts);
		expect(() => pb.collection('lists')).toThrow('unmocked collection lists');
	});
});
