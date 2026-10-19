// Things going wrong on the way: requests that never arrive, a server that
// errors, an answer lost after the server already acted, a session that
// expires with changes still queued. The promise under test is the same in
// every case — nothing the person did is lost, nothing is applied twice, and
// once the network behaves everyone converges.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { expectConverged, household, item, names } from './scenario';
import { World } from './world';

let world: World;
beforeEach(async () => {
	world = await World.create();
});
afterEach(() => world.close());

const PUSH = /\/api\/sync\/push/;
const ANY_READ = /\/api\/(sync\/(digest|snapshot)|collections)/;

describe('answers lost after the server acted', () => {
	test('a lost answer to an add does not create the item twice', async () => {
		const { anna, ben, listId } = await household(world);
		anna.fail(PUSH, 'lost-response');
		await anna.add(listId, 'Milch', { quantity: '2' });
		await world.settle(anna, ben);

		const view = await expectConverged(world, listId, anna, ben);
		expect(view.items.filter((i) => i.name === 'Milch')).toHaveLength(1);
		expect(item(view, 'Milch').quantity).toBe('2');
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	test('a lost answer to an edit applies it once, silently', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Brot', { quantity: '1' });
		await world.settle(anna, ben);

		anna.fail(PUSH, 'lost-response');
		await anna.edit(listId, 'Brot', { quantity: '2' });
		await anna.check(listId, 'Brot');
		await world.settle(anna, ben);

		expect(item(await expectConverged(world, listId, anna, ben), 'Brot')).toMatchObject({
			quantity: '2',
			state: 'checked'
		});
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	// [D-40]: the push committed, its answer was lost, and Anna changed the
	// same field again before the retry. A retry that carried her new value
	// against the base she started from — which the server no longer holds,
	// because it holds her FIRST value — would read as a conflict with herself:
	// the first value would stay and she would be told "someone had already set"
	// it. Her latest edit must stand, and nobody is told anything.
	test('a lost answer, then the same person edits again: their latest edit stands, silently', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Käse', { quantity: '1' });
		await world.settle(anna, ben);

		anna.fail(PUSH, 'lost-response', 99); // the server takes her 2, the answers never arrive
		await anna.edit(listId, 'Käse', { quantity: '2' });
		expect(await anna.trySync()).toBe(false);
		await anna.edit(listId, 'Käse', { quantity: '3' });
		anna.clearFaults();
		await world.settle(anna, ben);

		expect(item(await expectConverged(world, listId, anna, ben), 'Käse').quantity).toBe('3');
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});

	test('a lost answer, then someone else edits the same field: the later edit stands', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Käse', { quantity: '1' });
		await world.settle(anna, ben);

		anna.fail(PUSH, 'lost-response', 99); // Anna's answers keep getting lost…
		await anna.edit(listId, 'Käse', { quantity: '2' });
		expect(await anna.trySync()).toBe(false);
		await ben.sync(); // …while Ben sees her 2 and changes it
		expect(item(await ben.view(listId), 'Käse').quantity).toBe('2');
		await ben.edit(listId, 'Käse', { quantity: '3' });
		await ben.sync();

		anna.clearFaults();
		await world.settle(anna, ben);

		// Ben changed it after seeing Anna's value, so his is the latest intent.
		expect(item(await expectConverged(world, listId, anna, ben), 'Käse').quantity).toBe('3');
	});

	// The retry of a committed op must not undo what someone did after it
	// landed. Each person's later change sets the field back to the value
	// Anna's op started from, so a retry judged by its base alone would apply
	// again over it ([D-42]).
	test('a lost answer to a tick, then someone puts it back: it stays on the list', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		anna.fail(PUSH, 'lost-response', 99);
		await anna.check(listId, 'Milch');
		expect(await anna.trySync()).toBe(false);
		await ben.sync();
		expect(item(await ben.view(listId), 'Milch').state).toBe('checked');
		await ben.uncheck(listId, 'Milch');
		await ben.sync();

		anna.clearFaults();
		await world.settle(anna, ben);
		expect(item(await expectConverged(world, listId, anna, ben), 'Milch').state).toBe('active');
	});

	test('a lost answer, then someone sets the field back: their edit stands', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Käse', { quantity: '1' });
		await world.settle(anna, ben);

		anna.fail(PUSH, 'lost-response', 99);
		await anna.edit(listId, 'Käse', { quantity: '2' });
		expect(await anna.trySync()).toBe(false);
		await ben.sync();
		await ben.edit(listId, 'Käse', { quantity: '1' });
		await ben.sync();

		anna.clearFaults();
		await world.settle(anna, ben);
		expect(item(await expectConverged(world, listId, anna, ben), 'Käse').quantity).toBe('1');
	});

	test('a lost answer to a removal, then someone restores it: it stays restored', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Brot');
		await world.settle(anna, ben);
		await anna.check(listId, 'Brot');
		await world.settle(anna, ben);

		anna.fail(PUSH, 'lost-response', 99);
		await anna.remove(listId, 'Brot');
		expect(await anna.trySync()).toBe(false);
		await ben.sync();
		await ben.restore(listId, 'Brot');
		await ben.sync();

		anna.clearFaults();
		await world.settle(anna, ben);
		expect(item(await expectConverged(world, listId, anna, ben), 'Brot').state).not.toBe('removed');
	});
});

describe('realtime events that arrive late', () => {
	test('a stale event does not turn the next edit into a conflict with yourself', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Käse', { quantity: '1' });
		await world.settle(anna, ben);

		await world.broadcast(listId, [anna]); // on its way, still saying 1
		await anna.edit(listId, 'Käse', { quantity: '2' });
		await anna.sync();
		await anna.hear(); // arrives after her own 2 was answered
		await anna.edit(listId, 'Käse', { quantity: '3' });
		await world.settle(anna, ben);

		expect(item(await expectConverged(world, listId, anna, ben), 'Käse').quantity).toBe('3');
		expect(anna.takeNotices()).toEqual([]);
	});
});

describe('requests that fail outright', () => {
	test('a server error keeps the changes queued, and they arrive later', async () => {
		const { anna, ben, listId } = await household(world);
		anna.fail(PUSH, 'server-error', 99);
		await anna.add(listId, 'Eier');
		await anna.add(listId, 'Mehl');
		expect(await anna.trySync()).toBe(false);
		expect(await anna.unsynced()).toBeGreaterThan(0);
		expect(names(await anna.view(listId))).toEqual(['Eier', 'Mehl']);

		anna.clearFaults();
		await world.settle(anna, ben);
		expect(names(await expectConverged(world, listId, anna, ben))).toEqual(['Eier', 'Mehl']);
		expect(await anna.unsynced()).toBe(0);
	});

	test('failing reads never empty the list on the device', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Reis');
		await world.settle(anna, ben);
		const before = await ben.view(listId);

		for (const kind of ['unreachable', 'server-error', 'lost-response'] as const) {
			ben.fail(ANY_READ, kind, 99);
			expect(await ben.trySync()).toBe(false);
			expect(await ben.view(listId), `after reads failing with ${kind}`).toEqual(before);
			expect((await ben.lists()).map((l) => l.id)).toContain(listId);
			ben.clearFaults();
		}
	});

	test('a whole trip offline arrives complete', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		ben.offline();
		const bought = ['Brot', 'Butter', 'Käse', 'Äpfel', 'Bananen', 'Tomaten', 'Gurke'];
		for (const n of bought) await ben.add(listId, n);
		await ben.add(listId, 'Joghurt', { quantity: '4' });
		for (const n of bought) await ben.check(listId, n);
		await ben.check(listId, 'Milch');
		await ben.edit(listId, 'Joghurt', { quantity: '6', note: 'Natur' });
		await ben.remove(listId, 'Gurke');
		expect(await ben.trySync()).toBe(false);

		ben.online();
		await world.settle(ben, anna);
		const view = await expectConverged(world, listId, anna, ben);
		expect(names(view, 'checked')).toEqual([
			'Äpfel',
			'Bananen',
			'Brot',
			'Butter',
			'Käse',
			'Milch',
			'Tomaten'
		]);
		expect(item(view, 'Joghurt')).toMatchObject({ state: 'active', quantity: '6', note: 'Natur' });
		expect(item(view, 'Gurke')).toMatchObject({ state: 'removed', bought: true });
		expect([...anna.takeNotices(), ...ben.takeNotices()]).toEqual([]);
	});
});

describe('an expired session', () => {
	test('queued changes survive it, and arrive after signing back in', async () => {
		const { anna, ben, listId } = await household(world);
		await anna.add(listId, 'Milch');
		await world.settle(anna, ben);

		ben.offline();
		await ben.edit(listId, 'Milch', { quantity: '2' });
		await ben.add(listId, 'Kakao');
		ben.expireSession();
		ben.online();
		expect(await ben.trySync()).toBe(false);

		// Nothing purged, nothing lost, while signed out.
		expect((await ben.lists()).map((l) => l.id)).toContain(listId);
		expect(names(await ben.view(listId))).toEqual(['Kakao', 'Milch']);
		expect(item(await ben.view(listId), 'Milch').quantity).toBe('2');

		await ben.signBackIn();
		await world.settle(ben, anna);
		const view = await expectConverged(world, listId, anna, ben);
		expect(names(view)).toEqual(['Kakao', 'Milch']);
		expect(item(view, 'Milch').quantity).toBe('2');
	});
});
