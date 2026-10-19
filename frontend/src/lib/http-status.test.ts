import { describe, expect, it } from 'vitest';

import { httpStatus } from './http-status';

describe('httpStatus', () => {
	it('reads a numeric status, 0 included (no answer came)', () => {
		expect(httpStatus({ status: 404 })).toBe(404);
		expect(httpStatus(Object.assign(new Error('offline'), { status: 0 }))).toBe(0);
	});

	it('is undefined for anything without a numeric status', () => {
		for (const e of [null, undefined, 'boom', 42, new Error('x'), { status: '404' }]) {
			expect(httpStatus(e)).toBeUndefined();
		}
	});
});
