// Engine-free building blocks shared by the behaviour specs. Everything here
// goes through world.ts; nothing here knows how sync works.
import { expect } from 'vitest';

import { World, type Device, type ItemView, type ListView } from './world';

export interface Household {
	world: World;
	anna: Device;
	ben: Device;
	listId: string;
}

/** Anna creates a list and invites Ben through the real invite link; both synced. */
export async function household(world: World): Promise<Household> {
	const anna = await (await world.person('Anna')).device();
	const ben = await (await world.person('Ben')).device();
	const listId = await anna.createList('Wocheneinkauf');
	await ben.join(await anna.invite(listId));
	await world.settle(anna, ben);
	anna.takeNotices();
	ben.takeNotices();
	return { world, anna, ben, listId };
}

/** Every device sees exactly what the server holds for the list. */
export async function expectConverged(
	world: World,
	listId: string,
	...devices: Device[]
): Promise<ListView> {
	const server = await world.serverView(listId);
	for (const d of devices) {
		expect(await d.view(listId), `${d.label} shows what the server holds`).toEqual(server);
	}
	return server;
}

/** The one row with this name (throws if there is not exactly one). */
export function item(view: ListView, name: string): ItemView {
	const rows = view.items.filter((i) => i.name === name);
	if (rows.length !== 1) throw new Error(`expected one "${name}", found ${rows.length}`);
	return rows[0];
}

/** The one row with this name that is on the list (active or checked). */
export function living(view: ListView, name: string): ItemView {
	const rows = view.items.filter((i) => i.name === name && i.state !== 'removed');
	if (rows.length !== 1)
		throw new Error(`expected one "${name}" on the list, found ${rows.length}`);
	return rows[0];
}

export function names(view: ListView, state?: ItemView['state']): string[] {
	return view.items
		.filter((i) => (state ? i.state === state : i.state !== 'removed'))
		.map((i) => i.name)
		.sort((a, b) => a.localeCompare(b, 'de'));
}
