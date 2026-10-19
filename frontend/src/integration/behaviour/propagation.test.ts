// A change made on one device reaches every other device — the baseline every
// other behaviour spec builds on. Outcomes only: what each device shows, and
// that it matches the server.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { expectConverged, household, item, names } from './scenario';
import { World } from './world';

let world: World;
beforeEach(async () => {
	world = await World.create();
});
afterEach(() => world.close());

describe('a change on one device reaches the others', () => {
	test('an added item appears for the other member', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch', { quantity: '2' });
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Milch')).toMatchObject({ quantity: '2', state: 'active' });
	});

	test('edits to quantity, note and name arrive', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		await ben.edit(listId, 'Milch', { quantity: '3', note: 'laktosefrei' });
		await ben.edit(listId, 'Milch', { name: 'Hafermilch' });
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Hafermilch')).toMatchObject({ quantity: '3', note: 'laktosefrei' });
		expect(names(view)).toEqual(['Hafermilch']);
	});

	test('checking off, and unchecking, arrive — and the purchase is remembered', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Brot');
		await world.settle(anna, ben);

		await ben.check(listId, 'Brot');
		await world.settle(ben, anna);
		expect(item(await expectConverged(world, listId, anna, ben), 'Brot')).toMatchObject({
			state: 'checked',
			bought: true
		});

		await anna.uncheck(listId, 'Brot');
		await world.settle(anna, ben);
		expect(item(await expectConverged(world, listId, anna, ben), 'Brot')).toMatchObject({
			state: 'active',
			bought: true
		});
	});

	// [D-26] A tick taken back was no purchase: the item keeps the date it had.
	test('a tick taken back leaves no purchase, and an untick to buy again keeps it', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Brot');
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		await ben.check(listId, 'Brot');
		await ben.check(listId, 'Milch');
		await world.settle(ben, anna);
		await ben.takeBack(listId, 'Brot');
		await ben.uncheck(listId, 'Milch');
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Brot')).toMatchObject({ state: 'active', bought: false });
		expect(item(view, 'Milch')).toMatchObject({ state: 'active', bought: true });
	});

	test('removing and restoring arrive', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Eier');
		await anna.check(listId, 'Eier');
		await world.settle(anna, ben);

		await ben.remove(listId, 'Eier');
		await world.settle(ben, anna);
		expect(item(await expectConverged(world, listId, anna, ben), 'Eier').state).toBe('removed');

		await anna.restore(listId, 'Eier');
		await world.settle(anna, ben);
		expect(item(await expectConverged(world, listId, anna, ben), 'Eier').state).toBe('active');
	});

	test('renaming and hiding an aisle arrive', async () => {
		const { anna, ben, listId } = await household(world);
		const before = await anna.view(listId);
		const [first, second] = before.aisles.filter((a) => a.name !== 'other');

		await anna.renameAisle(listId, first.name, 'Kühlregal');
		await anna.hideAisle(listId, second.name);
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(view.aisles.map((a) => a.name)).toContain('Kühlregal');
		expect(view.aisles.find((a) => a.name === second.name)?.hidden).toBe(true);
	});

	test("one person's list appears on their other device", async () => {
		const anna = await world.person('Anna');
		const phone = await anna.device('phone');
		const tablet = await anna.device('tablet');
		const listId = await phone.createList('Drogerie');
		await phone.add(listId, 'Zahnpasta');
		await world.settle(phone, tablet);

		expect((await tablet.lists()).map((l) => l.id)).toContain(listId);
		expect(names(await expectConverged(world, listId, phone, tablet))).toEqual(['Zahnpasta']);
	});
});
