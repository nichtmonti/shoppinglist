// Lists and memberships over time: joining a list with a history, leaving it
// while another device still has queued changes, the last member leaving, and
// the per-member privacy of a list's name. Outcomes only.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { expectConverged, household, item, names } from './scenario';
import { World } from './world';

let world: World;
beforeEach(async () => {
	world = await World.create();
});
afterEach(() => world.close());

describe('joining', () => {
	test('a new member sees the whole list, history included', async () => {
		const anna = await (await world.person('Anna')).device();
		const listId = await anna.createList('Vorrat');
		await anna.add(listId, 'Reis', { quantity: '1 kg' });
		await anna.add(listId, 'Nudeln');
		await anna.check(listId, 'Nudeln');
		await anna.add(listId, 'Mehl');
		await anna.check(listId, 'Mehl');
		await anna.remove(listId, 'Mehl'); // bought before, so remembered
		await anna.sync();

		const ben = await (await world.person('Ben')).device();
		await ben.join(await anna.invite(listId));
		await ben.sync();

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Reis')).toMatchObject({ state: 'active', quantity: '1 kg' });
		expect(item(view, 'Nudeln')).toMatchObject({ state: 'checked', bought: true });
		expect(item(view, 'Mehl')).toMatchObject({ state: 'removed', bought: true });
	});

	test("a joiner's other device picks the list up too", async () => {
		const anna = await (await world.person('Anna')).device();
		const ben = await world.person('Ben');
		const phone = await ben.device('phone');
		const tablet = await ben.device('tablet');
		const listId = await anna.createList('Party');
		await anna.add(listId, 'Chips');
		await anna.sync();

		await phone.join(await anna.invite(listId));
		await tablet.sync();

		expect((await tablet.lists()).map((l) => l.id)).toContain(listId);
		expect(names(await expectConverged(world, listId, phone, tablet))).toEqual(['Chips']);
	});
});

describe('leaving', () => {
	test('leaving on one device removes the list from the other, and its queued changes go nowhere', async () => {
		const { anna, listId, ...h } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, h.ben);

		const benTablet = await world.deviceFor(h.ben.account, 'tablet');
		await benTablet.sync();
		benTablet.offline();
		await benTablet.add(listId, 'Chips');
		await benTablet.edit(listId, 'Milch', { quantity: '9' });

		await h.ben.leave(listId);
		benTablet.online();
		await benTablet.sync();

		expect((await benTablet.lists()).map((l) => l.id)).not.toContain(listId);
		expect(benTablet.takeNotices()).toEqual([{ kind: 'list-gone', list: 'Wocheneinkauf' }]);
		expect(await benTablet.unsynced()).toBe(0);
		// The list lives on for Anna, untouched by the departed member's queue.
		await anna.sync();
		const view = await expectConverged(world, listId, anna);
		expect(names(view)).toEqual(['Milch']);
		expect(item(view, 'Milch').quantity).toBe('');
	});

	test('when the last member leaves, the list is gone everywhere', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);
		const annaTablet = await world.deviceFor(anna.account, 'tablet');
		await annaTablet.sync();
		annaTablet.offline();
		await annaTablet.check(listId, 'Milch');

		await ben.leave(listId);
		await anna.leave(listId);
		expect(await world.listExists(listId)).toBe(false);

		annaTablet.online();
		await annaTablet.sync();
		expect(await annaTablet.lists()).toEqual([]);
		expect(await annaTablet.view(listId)).toEqual({ items: [], aisles: [] });
		expect(annaTablet.takeNotices()).toEqual([{ kind: 'list-gone', list: 'Wocheneinkauf' }]);
	});

	test('leaving and joining again brings the whole list back', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Brot');
		await world.settle(anna, ben);

		await ben.leave(listId);
		await anna.add(listId, 'Butter');
		await anna.sync();
		await ben.join(await anna.invite(listId));
		await ben.sync();

		expect(names(await expectConverged(world, listId, anna, ben))).toEqual(['Brot', 'Butter']);
	});
});

describe("a list's name is every member's ([D-08])", () => {
	test('renaming changes it for every member, on every device', async () => {
		const { anna, ben, listId } = await household(world);
		const annaTablet = await world.deviceFor(anna.account, 'tablet');
		await ben.renameList(listId, 'Samstag');
		await world.settle(anna, ben, annaTablet);

		for (const device of [anna, annaTablet, ben]) {
			expect((await device.lists()).find((l) => l.id === listId)?.name).toBe('Samstag');
		}
		expect(await world.serverLists(ben.account)).toEqual(await ben.lists());
		expect(await world.serverLists(anna.account)).toEqual(await anna.lists());
	});
});

describe('forgetting purchase times', () => {
	test('a check-off made offline during the reset still counts as bought', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await anna.add(listId, 'Brot');
		await anna.check(listId, 'Milch');
		await world.settle(anna, ben);

		ben.offline();
		await ben.check(listId, 'Brot');
		await anna.clearHistory(listId);
		ben.online();
		await world.settle(ben, anna);

		const view = await expectConverged(world, listId, anna, ben);
		expect(item(view, 'Milch').bought).toBe(false);
		expect(item(view, 'Brot')).toMatchObject({ state: 'checked', bought: true });
	});
});

describe("the server's clean-up", () => {
	test('a removed item cleared out for good leaves every device; an edit queued on it is refused', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await anna.add(listId, 'Brot');
		await anna.hideAisle(listId, item(await anna.view(listId), 'Brot').aisle);
		await world.settle(anna, ben);

		ben.offline();
		await ben.edit(listId, 'Milch', { note: 'Bio' });
		await anna.remove(listId, 'Milch');
		await anna.sync();
		expect(await world.sweep(listId)).toEqual(['Milch']);
		ben.online();
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(view.items.map((i) => i.name)).toEqual(['Brot']);
		expect(view.aisles.some((a) => a.hidden)).toBe(false);
		expect(ben.takeNotices()).toMatchObject([{ kind: 'refused', reason: 'row_missing' }]);
		expect(anna.takeNotices()).toEqual([]);
	});
});
