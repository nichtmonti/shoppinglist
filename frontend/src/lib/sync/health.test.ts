// [D-296] What the leader records of each exchange, for every tab's status.
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getMeta } from '#lib/db.js';
import { failureOf, recordExchange, recordStart, SYNC_HEALTH_KEY } from './health';
import { endSession, resetSessionForTest, sessionScope } from '#lib/auth/session.js';

describe('failureOf', () => {
	it('reads a 429 as the rate limit, another answer as the server, none as the connection', () => {
		expect(failureOf(Object.assign(new Error('x'), { status: 429 }))).toBe('rate');
		expect(failureOf(Object.assign(new Error('x'), { status: 502 }))).toBe('server');
		expect(failureOf(Object.assign(new Error('x'), { status: 0 }))).toBe('connection');
	});

	// A refusal repeats on every try, so "server not answering" would mislead.
	it('reads a request the server refuses as the app’s own', () => {
		for (const status of [400, 403, 404, 413]) {
			expect(failureOf(Object.assign(new Error('x'), { status }))).toBe('app');
		}
		for (const status of [401, 408]) {
			expect(failureOf(Object.assign(new Error('x'), { status }))).toBe('server');
		}
	});

	// apiJson gives a request without an answer status 0 (http.test.ts).
	it('reads an error without a status as the app’s own', () => {
		expect(failureOf(new TypeError("Cannot read properties of undefined (reading 'digest')"))).toBe(
			'app'
		);
	});
});

describe('recordExchange', () => {
	beforeEach(async () => {
		await db.meta.delete(SYNC_HEALTH_KEY);
	});

	it('counts failures in a row and clears them on the next good exchange', async () => {
		const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, s));
		await recordStart(at(0));
		await recordExchange(null, at(1));
		await recordStart(at(5));
		await recordExchange(Object.assign(new Error('x'), { status: 503 }), at(6));
		await recordStart(at(10));
		await recordExchange(Object.assign(new Error('no answer'), { status: 0 }), at(11));

		let health = await getMeta(SYNC_HEALTH_KEY);
		expect(health).toEqual({
			ok_at: at(1).toISOString(),
			started_at: at(10).toISOString(),
			ended_at: at(11).toISOString(),
			failures: 2,
			reason: 'connection'
		});

		await recordExchange(null, at(15));
		health = await getMeta(SYNC_HEALTH_KEY);
		expect(health).toEqual({
			ok_at: at(15).toISOString(),
			started_at: at(10).toISOString(),
			ended_at: at(15).toISOString(),
			failures: 0,
			reason: null
		});
	});
});

// §5.6 [D-109]: the status is account data the sign-out wipes, so an exchange
// that outlives its account's session writes nothing behind the wipe.
describe('an exchange whose session has ended', () => {
	beforeEach(async () => {
		await db.meta.delete(SYNC_HEALTH_KEY);
	});

	it('records nothing', async () => {
		const exchange = sessionScope();
		endSession();
		try {
			await recordStart(new Date(), exchange);
			await recordExchange(null, new Date(), exchange);
			expect(await getMeta(SYNC_HEALTH_KEY)).toBeUndefined();
		} finally {
			resetSessionForTest();
		}
	});
});
