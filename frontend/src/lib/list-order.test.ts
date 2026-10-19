import { describe, expect, it } from 'vitest';

import type { ListRow } from './db';
import type { MyList } from './state/data';
import { reconcileOrder, sortLists } from './list-order';

function member(list: string, name: string): MyList {
	return { id: `m-${list}`, account: 'a', list, name, created: '', updated: '' };
}

const rows = [member('l1', 'Wocheneinkauf'), member('l2', 'Baumarkt'), member('l3', 'Party')];
const names = (sorted: MyList[]) => sorted.map((m) => m.name);

describe('sortLists', () => {
	it('alphabetical: by the list’s name ([D-08])', () => {
		expect(names(sortLists(rows, 'alphabetical', [], []))).toEqual([
			'Baumarkt',
			'Party',
			'Wocheneinkauf'
		]);
	});

	it('custom: by the saved order, lists it does not know yet last', () => {
		expect(names(sortLists(rows, 'custom', ['l3', 'l1'], []))).toEqual([
			'Party',
			'Wocheneinkauf',
			'Baumarkt'
		]);
	});

	it('activity: newest list-index activity first, lists without an entry last', () => {
		const index: ListRow[] = [
			{ id: 'l1', name: 'Wocheneinkauf', updated: '2026-09-20 10:00:00.000Z' },
			{ id: 'l3', name: 'Party', updated: '2026-09-25 10:00:00.000Z' }
		];
		expect(names(sortLists(rows, 'activity', [], index))).toEqual([
			'Party',
			'Wocheneinkauf',
			'Baumarkt'
		]);
	});

	it('never reorders its input in place', () => {
		const input = [...rows];
		sortLists(input, 'alphabetical', [], []);
		expect(input).toEqual(rows);
	});
});

describe('reconcileOrder', () => {
	it('puts lists missing from the saved order first', () => {
		expect(reconcileOrder(['l1', 'l2'], ['l1', 'l2', 'l3'])).toEqual(['l3', 'l1', 'l2']);
	});

	it('drops lists the user no longer has', () => {
		expect(reconcileOrder(['l1', 'gone', 'l2'], ['l1', 'l2'])).toEqual(['l1', 'l2']);
	});

	it('is null when the order already matches, so nothing is written', () => {
		expect(reconcileOrder(['l2', 'l1'], ['l1', 'l2'])).toBeNull();
	});
});
