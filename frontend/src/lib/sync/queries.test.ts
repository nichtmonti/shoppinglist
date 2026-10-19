import { beforeEach, describe, expect, it } from 'vitest';
import { makeItem, putSynced, resetDb } from '#lib/test-kit/db.js';
import {
	queryLatestCheckOffs,
	queryOpenRows,
	queryRememberedRows,
	queryShelfCounts
} from './queries';

const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) =>
	new Date(Date.UTC(2026, 9, 16, 12) - hoursAgo * HOUR).toISOString();
const checked = (name: string, hoursAgo: number) =>
	makeItem({
		list: 'l',
		name,
		checked: true,
		checked_at: at(hoursAgo),
		last_bought_at: at(hoursAgo)
	});

describe('a list read by shelf ([D-308])', () => {
	beforeEach(async () => {
		await resetDb();
		await putSynced([
			makeItem({ list: 'l', name: 'Milch' }),
			checked('Brot', 0),
			checked('Eier', 2),
			checked('Käse', 6), // three hours after Eier: before the latest run
			checked('Senf', 300),
			makeItem({ list: 'l', name: 'Weg', deleted_at: at(1), last_bought_at: at(50) }),
			makeItem({ list: 'l', name: 'Vertippt', deleted_at: at(1) }),
			makeItem({ list: 'other', name: 'Fremd' })
		]);
	});

	it('counts each shelf without the never-bought tombstone or another list', async () => {
		expect(await queryShelfCounts('l')).toEqual({ open: 1, done: 4, kept: 1 });
	});

	it('reads the active rows alone', async () => {
		expect((await queryOpenRows('l')).map((i) => i.name)).toEqual(['Milch']);
	});

	it('reads the latest run of check-offs, newest first, up to the first long pause', async () => {
		const run = await queryLatestCheckOffs('l', 3 * HOUR);
		expect(run.map((i) => i.name)).toEqual(['Brot', 'Eier']);
	});

	it('remembers living and bought-then-removed rows, never a removed one never bought', async () => {
		const names = (await queryRememberedRows('l')).map((i) => i.name).sort();
		expect(names).toEqual(['Brot', 'Eier', 'Käse', 'Milch', 'Senf', 'Weg']);
	});
});
