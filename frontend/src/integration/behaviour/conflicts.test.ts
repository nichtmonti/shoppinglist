// Concurrent edits resolve the way docs/internals/design.md §8.1–§8.4 promises, judged only by
// what every device ends up showing and what each person was told:
//   - different fields of one item both survive;
//   - the same field: the value the server took FIRST wins, and the other
//     person gets a passive notice — never silence, never a prompt;
//   - identical intent (both check off, both remove) converges without a notice;
//   - an edit to something removed meanwhile is reported, not resurrected;
//   - a duplicate add merges into one row.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { expectConverged, household, item, living, names } from './scenario';
import { World } from './world';

let world: World;
beforeEach(async () => {
	world = await World.create();
});
afterEach(() => world.close());

describe('edits made at the same time', () => {
	test('different fields of the same item both survive, silently', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch', { quantity: '1' });
		await world.settle(anna, ben);

		anna.offline();
		ben.offline();
		await anna.edit(listId, 'Milch', { quantity: '2' });
		await ben.edit(listId, 'Milch', { note: 'Bio' });
		anna.online();
		ben.online();
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Milch')).toMatchObject({ quantity: '2', note: 'Bio' });
		expect(anna.takeNotices()).toEqual([]);
		expect(ben.takeNotices()).toEqual([]);
	});

	test('checking off while the other renames keeps both', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		anna.offline();
		await anna.check(listId, 'Milch');
		await ben.edit(listId, 'Milch', { name: 'Vollmilch' });
		await ben.sync();
		anna.online();
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Vollmilch')).toMatchObject({ state: 'checked', bought: true });
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	for (const first of ['anna', 'ben'] as const) {
		test(`the same field: the first to reach the server (${first}) wins, the other is told`, async () => {
			const h = await household(world);
			const { listId } = h;
			await h.anna.add(listId, 'Äpfel', { quantity: '1' });
			await world.settle(h.anna, h.ben);

			h.anna.offline();
			h.ben.offline();
			await h.anna.edit(listId, 'Äpfel', { quantity: '6' });
			await h.ben.edit(listId, 'Äpfel', { quantity: '2 kg' });
			const [winner, loser] = first === 'anna' ? [h.anna, h.ben] : [h.ben, h.anna];
			const [won, lost] = first === 'anna' ? ['6', '2 kg'] : ['2 kg', '6'];
			winner.online();
			await winner.sync();
			loser.online();
			await world.settle(loser, winner);

			const view = await expectConverged(world, listId, h.anna, h.ben);
			expect(item(view, 'Äpfel').quantity).toBe(won);
			expect(winner.takeNotices()).toEqual([]);
			expect(loser.takeNotices()).toEqual([
				{ kind: 'conflict', item: 'Äpfel', field: 'quantity', mine: lost, theirs: won }
			]);
		});
	}

	test('both syncing at the same instant: exactly one wins, exactly one is told', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Käse', { quantity: '1' });
		await world.settle(anna, ben);

		await anna.edit(listId, 'Käse', { quantity: 'Anna' });
		await ben.edit(listId, 'Käse', { quantity: 'Ben' });
		await Promise.all([anna.sync(), ben.sync()]);
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		const winner = item(view, 'Käse').quantity;
		expect(['Anna', 'Ben']).toContain(winner);
		const told = [...anna.takeNotices(), ...ben.takeNotices()];
		expect(told).toEqual([
			{
				kind: 'conflict',
				item: 'Käse',
				field: 'quantity',
				mine: winner === 'Anna' ? 'Ben' : 'Anna',
				theirs: winner
			}
		]);
	});

	test('the loser can simply edit again, and that edit applies without a second notice', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Butter', { quantity: '1' });
		await world.settle(anna, ben);

		ben.offline();
		await ben.edit(listId, 'Butter', { quantity: '3' });
		await anna.edit(listId, 'Butter', { quantity: '2' });
		await anna.sync();
		ben.online();
		await ben.sync();
		expect(ben.takeNotices()).toHaveLength(1);

		await ben.edit(listId, 'Butter', { quantity: '3' });
		await world.settle(ben, anna);
		expect(item(await expectConverged(world, listId, anna, ben), 'Butter').quantity).toBe('3');
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	test('many offline edits to one field arrive as the last one, silently', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Wasser', { quantity: '1' });
		await world.settle(anna, ben);

		ben.offline();
		for (const q of ['2', '3', '4', '5', '6 Flaschen'])
			await ben.edit(listId, 'Wasser', { quantity: q });
		ben.online();
		await world.settle(ben, anna);

		expect(item(await expectConverged(world, listId, anna, ben), 'Wasser').quantity).toBe(
			'6 Flaschen'
		);
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});
});

describe('the same intent twice converges without a notice', () => {
	test('both check off the same item', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		anna.offline();
		ben.offline();
		await anna.check(listId, 'Milch');
		await ben.check(listId, 'Milch');
		anna.online();
		ben.online();
		await world.settle(anna, ben);

		expect(item(await expectConverged(world, listId, anna, ben), 'Milch')).toMatchObject({
			state: 'checked',
			bought: true
		});
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	test('both remove the same item', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Senf');
		await world.settle(anna, ben);

		anna.offline();
		ben.offline();
		await anna.remove(listId, 'Senf');
		await ben.remove(listId, 'Senf');
		anna.online();
		ben.online();
		await world.settle(anna, ben);

		expect(item(await expectConverged(world, listId, anna, ben), 'Senf').state).toBe('removed');
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	test('both set the same quantity', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Eier', { quantity: '6' });
		await world.settle(anna, ben);

		anna.offline();
		ben.offline();
		await anna.edit(listId, 'Eier', { quantity: '10' });
		await ben.edit(listId, 'Eier', { quantity: '10' });
		anna.online();
		ben.online();
		await world.settle(anna, ben);

		expect(item(await expectConverged(world, listId, anna, ben), 'Eier').quantity).toBe('10');
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});
});

describe('removing while someone edits', () => {
	test('removed first: the late edit is reported and the item stays removed', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Joghurt', { quantity: '4' });
		await world.settle(anna, ben);

		ben.offline();
		await ben.edit(listId, 'Joghurt', { quantity: '8' });
		await anna.remove(listId, 'Joghurt');
		await anna.sync();
		ben.online();
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Joghurt')).toMatchObject({ state: 'removed', quantity: '4' });
		expect(ben.takeNotices()).toEqual([{ kind: 'removed-while-editing', item: 'Joghurt' }]);
		expect(anna.takeNotices()).toEqual([]);
	});

	test('edited first: the edit lands, then the removal — nobody is told', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Joghurt', { quantity: '4' });
		await world.settle(anna, ben);

		anna.offline();
		await anna.remove(listId, 'Joghurt');
		await ben.edit(listId, 'Joghurt', { quantity: '8' });
		await ben.sync();
		anna.online();
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Joghurt')).toMatchObject({ state: 'removed', quantity: '8' });
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});
});

describe('a purchase made while someone else removed the item', () => {
	// [D-175]: the late removal converges, and the check-off riding in it must
	// not be dropped with it — or the list forgets the item was ever bought and
	// it never reaches "Frühere Artikel".
	test('is still remembered', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Brot');
		await world.settle(anna, ben);

		ben.offline();
		await ben.check(listId, 'Brot'); // Ben buys it…
		await ben.remove(listId, 'Brot'); // …and clears it off his list
		await anna.remove(listId, 'Brot'); // Anna removes it too, and syncs first
		await anna.sync();
		ben.online();
		await world.settle(ben, anna);

		expect(item(await expectConverged(world, listId, anna, ben), 'Brot')).toMatchObject({
			state: 'removed',
			bought: true
		});
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});
});

describe('bringing an item back while someone re-added it', () => {
	// [D-176], found by the stress run: Anna could not match Ben's row (she never
	// learned he bought it), so she created a new one; Ben's restore then lifted
	// the old one beside it — two rows of one name.
	async function reAddedMeanwhile() {
		const h = await household(world);
		const { anna, ben, listId } = h;
		await anna.add(listId, 'Brot');
		await world.settle(anna, ben);

		ben.offline();
		await ben.check(listId, 'Brot');
		await ben.remove(listId, 'Brot'); // remembered on Ben's phone
		await anna.remove(listId, 'Brot');
		await anna.sync();
		await anna.add(listId, 'Brot', { quantity: '2' }); // not remembered on Anna's: a new row
		await anna.sync();
		return h;
	}

	test('restoring from history leaves one row', async () => {
		const { anna, ben, listId } = await reAddedMeanwhile();
		await ben.restore(listId, 'Brot');
		ben.online();
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(names(view)).toEqual(['Brot']);
		expect(living(view, 'Brot')).toMatchObject({ state: 'active', quantity: '2' });
		// Not also listed under "Frühere Artikel" beside the row on the list.
		expect(
			view.items.filter((i) => i.name === 'Brot' && i.state === 'removed' && i.bought)
		).toEqual([]);
	});

	test('typing the name again does the same', async () => {
		const { anna, ben, listId } = await reAddedMeanwhile();
		await ben.add(listId, 'Brot'); // the add box finds Ben's remembered row
		ben.online();
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(names(view)).toEqual(['Brot']);
		expect(living(view, 'Brot').quantity).toBe('2');
	});

	test('a different quantity on the way back is reported, the first one kept', async () => {
		const { anna, ben, listId } = await reAddedMeanwhile();
		await ben.add(listId, 'Brot', { quantity: '5' });
		ben.online();
		await world.settle(ben, anna);

		expect(living(await expectConverged(world, listId, anna, ben), 'Brot').quantity).toBe('2');
		expect(ben.takeNotices()).toEqual([
			{ kind: 'conflict', item: 'Brot', field: 'quantity', mine: '5', theirs: '2' }
		]);
		expect(anna.takeNotices()).toEqual([]);
	});
});

describe('adding the same thing twice', () => {
	test('both add it offline: one row, the first quantity kept, the second person told', async () => {
		const { anna, ben, listId } = await household(world);
		anna.offline();
		ben.offline();
		await anna.add(listId, 'Butter', { quantity: '1' });
		await ben.add(listId, 'Butter', { quantity: '2' });
		anna.online();
		await anna.sync();
		ben.online();
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(names(view)).toEqual(['Butter']);
		expect(item(view, 'Butter').quantity).toBe('1');
		expect(anna.takeNotices()).toEqual([]);
		expect(ben.takeNotices()).toEqual([
			{ kind: 'conflict', item: 'Butter', field: 'quantity', mine: '2', theirs: '1' }
		]);
	});

	test('the same name with different case or spacing is still one row', async () => {
		const { anna, ben, listId } = await household(world);
		anna.offline();
		ben.offline();
		await anna.add(listId, 'Hafermilch');
		await ben.add(listId, '  hafermilch ');
		anna.online();
		ben.online();
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(view.items.filter((i) => i.state !== 'removed')).toHaveLength(1);
	});

	test('a duplicate that discarded nothing stays silent', async () => {
		const { anna, ben, listId } = await household(world);
		anna.offline();
		ben.offline();
		await anna.add(listId, 'Salz', { quantity: '1' });
		await ben.add(listId, 'Salz');
		anna.online();
		ben.online();
		await world.settle(anna, ben);

		expect(names(await expectConverged(world, listId, anna, ben))).toEqual(['Salz']);
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	test('re-adding something checked off brings that row back instead of a second one', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Kaffee');
		await anna.check(listId, 'Kaffee');
		await world.settle(anna, ben);

		await ben.add(listId, 'Kaffee');
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(view.items.filter((i) => i.name === 'Kaffee')).toEqual([
			expect.objectContaining({ state: 'active', bought: true })
		]);
	});
});

describe('a change the server refuses', () => {
	test('the person is told, and the row goes back to what the server has', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch', { note: 'kurz' });
		await world.settle(anna, ben);

		ben.offline();
		await ben.edit(listId, 'Milch', { note: 'x'.repeat(5000) });
		ben.online();
		await world.settle(ben, anna);

		expect(item(await expectConverged(world, listId, anna, ben), 'Milch').note).toBe('kurz');
		expect(ben.takeNotices()).toEqual([
			{ kind: 'refused', item: 'Milch', field: 'note', reason: 'field_too_long' }
		]);
	});

	// [D-40]: while Ben's refused edit was still waiting, his device already
	// received Anna's newer note. Going back must land on HER note — the
	// server's — not on the one Ben started from.
	test('a refused edit does not bring back a value someone replaced meanwhile', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch', { note: 'kurz' });
		await world.settle(anna, ben);

		await ben.edit(listId, 'Milch', { note: 'x'.repeat(5000) });
		await anna.edit(listId, 'Milch', { note: 'Bio' });
		await anna.sync();
		// Ben's send fails once, but the rest of that sync goes through: he then
		// holds Anna's row with his own edit still waiting on top of it, and the
		// retry is refused.
		ben.fail(/\/api\/sync\/push/, 'server-error', 1);
		await world.settle(ben, anna);

		expect(item(await expectConverged(world, listId, anna, ben), 'Milch').note).toBe('Bio');
		expect(ben.takeNotices()).toEqual([
			{ kind: 'refused', item: 'Milch', field: 'note', reason: 'field_too_long' }
		]);
	});
});
