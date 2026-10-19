// Randomized stress: four devices (two people, each with a phone and a tablet)
// hammer one shared list with random actions — adds from a small pool of names
// so they collide, some spelt in another case or spacing, edits, renames,
// moves to another aisle, check-offs, removals, restores, aisle renames, hides
// and restores, a purchase-history reset — while randomly going offline,
// syncing alone or several at once, tapping while mid-sync, having their
// sessions expire and their answers lost or their requests refused (writes
// and reads), hearing realtime events late or not at all, and the server
// clears out removed rows every device has seen removed. Then everyone
// reconnects, signs back in and settles.
//
// The oracle knows nothing about how sync works; it checks what must hold for
// ANY correct engine under docs/internals/design.md §8's rules:
//   1. convergence — every device shows exactly what the server holds, and has
//      nothing left unsynced;
//   2. no loss — every name anyone added is still on the server (a duplicate add
//      merges into one row, never into nothing), unless a rename took it away
//      or the server's clean-up did, and nobody added it again since;
//      a rename may itself be lost, to an earlier rename or a removal (§8.3);
//   3. no phantoms — nothing is on the server that nobody added or renamed to;
//   4. no duplicates — at most one living row per name;
//   5. no invention — every quantity and note is one somebody actually typed.
// A name is compared as the server merges it (§9's normalized name), so
// "milch" and "Milch" are one name; a rename only ever picks a name nobody
// has, since a rename into a name on the list is not merged (§8.3).
//
// Seeds are fixed so a failure reproduces: the message names the seed, and
// STRESS_SEEDS="17,18" re-runs just those. STRESS_STEPS lengthens each run, and
// STRESS_TRACE=<name> adds the server's rows for that name to the log.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { normalizeName as key } from '#lib/normalize.js';

import { names } from './scenario';
import { World, type Device, type ListView } from './world';

const SEEDS = (process.env.STRESS_SEEDS ?? '1,2,3,4,5,6,7,8')
	.split(',')
	.map((s) => Number(s.trim()))
	.filter(Number.isFinite);
const STEPS = Number(process.env.STRESS_STEPS ?? 60);
// STRESS_TRACE=<name> logs the server's rows for that name after every step.
const TRACE = process.env.STRESS_TRACE;

const POOL = [
	'Milch',
	'Brot',
	'Butter',
	'Käse',
	'Äpfel',
	'Eier',
	'Kaffee',
	'Reis',
	'Nudeln',
	'Tee'
];
const PUSH = /\/api\/sync\/push/;
// Faults land on writes and reads alike, and on the history reset's route.
const FAULTED = [PUSH, PUSH, /\/api\/sync\/digest/, /\/api\/sync\/snapshot/, /clear-history/];

/** mulberry32 — tiny, seedable, good enough to pick actions. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)]
	};
}

let world: World;
beforeEach(async () => {
	world = await World.create();
});
afterEach(() => world.close());

/** What people typed, by normalized name. */
interface Written {
	added: Set<string>;
	/** Names a rename gave a row: allowed on the server, not owed. */
	renamedTo: Set<string>;
	/** Names a rename took a row away from: such a name may be gone. */
	renamedFrom: Set<string>;
	/** Names the server's clean-up took, not added since: such a name may be gone. */
	swept: Set<string>;
	/** Names joined by a rename, either way round: a device that has not seen
	 *  the rename yet still edits the row under its old name. */
	lineage: Map<string, string>;
	quantity: Map<string, Set<string>>;
	note: Map<string, Set<string>>;
}

function root(w: Written, name: string): string {
	let k = key(name);
	while (w.lineage.has(k) && w.lineage.get(k) !== k) k = w.lineage.get(k)!;
	return k;
}

/** Whether `value` was typed for the row's name or any name it had. */
function typed(w: Written, map: Map<string, Set<string>>, name: string, value: string): boolean {
	const r = root(w, name);
	const kin = [...map.keys()].filter((k) => root(w, k) === r);
	return kin.length === 0 ? value === '' : kin.some((k) => map.get(k)!.has(value));
}

function remember(map: Map<string, Set<string>>, name: string, value: string) {
	if (!map.has(key(name))) map.set(key(name), new Set(['']));
	map.get(key(name))!.add(value);
}

/** The same name as someone else might type it. */
function respell(name: string, roll: number): string {
	if (roll < 0.4) return name.toLowerCase();
	if (roll < 0.7) return name.toUpperCase();
	return ` ${name.replace(/ /g, '  ')} `;
}

describe('randomized stress on one shared list', () => {
	for (const seed of SEEDS) {
		test(`seed ${seed}: ${STEPS} random steps, then everyone converges`, async () => {
			const r = rng(seed);
			const anna = await world.person('Anna');
			const ben = await world.person('Ben');
			const phone = await anna.device('anna-phone');
			const tablet = await anna.device('anna-tablet');
			const benPhone = await ben.device('ben-phone');
			const benTablet = await ben.device('ben-tablet');
			const devices = [phone, tablet, benPhone, benTablet];
			const listId = await phone.createList('Stress');
			await benPhone.join(await phone.invite(listId));
			await world.settle(...devices);

			const written: Written = {
				added: new Set(),
				renamedTo: new Set(),
				renamedFrom: new Set(),
				swept: new Set(),
				lineage: new Map(),
				quantity: new Map(),
				note: new Map()
			};
			const log: string[] = [];
			const offline = new Set<Device>();
			const expired = new Set<Device>();

			const living = (v: ListView, state?: 'active' | 'checked') =>
				v.items.filter((i) => (state ? i.state === state : i.state !== 'removed'));

			for (let step = 0; step < STEPS; step++) {
				const d = r.pick(devices);
				const view = await d.view(listId);
				const shownAisles = view.aisles.filter((a) => !a.hidden);
				const roll = r.next();
				let action = '';
				// Now and then the person taps while their device is mid-sync.
				const wire = !offline.has(d) && r.next() < 0.1 ? d.trySync() : undefined;
				if (wire) log.push(`${step}: ${d.label} (syncing meanwhile)`);
				try {
					if (roll < 0.2) {
						const pooled = r.pick(POOL);
						const name = r.next() < 0.25 ? respell(pooled, r.next()) : pooled;
						const quantity = r.next() < 0.5 ? String(1 + r.int(9)) : '';
						action = `add ${JSON.stringify(name)} q=${quantity}`;
						written.added.add(key(name));
						written.swept.delete(key(name));
						remember(written.quantity, name, quantity);
						await d.add(listId, name, quantity ? { quantity } : {});
					} else if (roll < 0.34 && living(view).length) {
						const it = r.pick(living(view));
						if (r.next() < 0.5) {
							const quantity = `${1 + r.int(20)}${r.pick(['', ' kg', ' Stück'])}`;
							action = `edit ${it.name} quantity=${quantity}`;
							remember(written.quantity, it.name, quantity);
							await d.edit(listId, it.name, { quantity });
						} else {
							const note = r.pick(['Bio', 'günstig', 'die große', `n${step}`]);
							action = `edit ${it.name} note=${note}`;
							remember(written.note, it.name, note);
							await d.edit(listId, it.name, { note });
						}
					} else if (roll < 0.4 && living(view).length) {
						const it = r.pick(living(view));
						// A name nobody has, or the same one in another case.
						const name =
							r.next() < 0.6
								? `${it.name.split(' ')[0]} ${step}`
								: it.name === it.name.toLowerCase()
									? it.name.toUpperCase()
									: it.name.toLowerCase();
						action = `rename ${it.name} -> ${name}`;
						if (key(name) !== key(it.name)) written.renamedFrom.add(key(it.name));
						written.renamedTo.add(key(name));
						const [a, b] = [root(written, it.name), root(written, name)];
						if (a !== b) written.lineage.set(b, a);
						await d.edit(listId, it.name, { name });
					} else if (roll < 0.45 && living(view).length && shownAisles.length > 1) {
						const it = r.pick(living(view));
						const aisle = r.pick(shownAisles.filter((a) => a.name !== it.aisle));
						action = `move ${it.name} -> ${aisle.name}`;
						await d.move(listId, it.name, aisle.name);
					} else if (roll < 0.55 && living(view, 'active').length) {
						const it = r.pick(living(view, 'active'));
						action = `check ${it.name}`;
						await d.check(listId, it.name);
					} else if (roll < 0.6 && living(view, 'checked').length) {
						const it = r.pick(living(view, 'checked'));
						// Half of them take the tick back (not bought), half re-add.
						if (r.next() < 0.5) {
							action = `take back ${it.name}`;
							await d.takeBack(listId, it.name);
						} else {
							action = `uncheck ${it.name}`;
							await d.uncheck(listId, it.name);
						}
					} else if (roll < 0.65 && living(view).length) {
						const it = r.pick(living(view));
						action = `remove ${it.name}`;
						await d.remove(listId, it.name);
					} else if (roll < 0.69) {
						const back = view.items.filter(
							(i) =>
								i.state === 'removed' &&
								i.bought &&
								!living(view).some((l) => key(l.name) === key(i.name))
						);
						if (back.length) {
							const it = r.pick(back);
							action = `restore ${it.name}`;
							await d.restore(listId, it.name);
						}
					} else if (roll < 0.71) {
						const hidden = view.aisles.filter((a) => a.hidden);
						const pick = r.next();
						if (pick < 0.4) {
							const aisle = r.pick(shownAisles);
							action = `rename aisle ${aisle.name} -> Gang ${step}`;
							await d.renameAisle(listId, aisle.name, `Gang ${step}`);
						} else if (pick < 0.75 || !hidden.length) {
							// The Others aisle refuses, which the step logs as skipped.
							const aisle = r.pick(shownAisles);
							action = `hide aisle ${aisle.name}`;
							await d.hideAisle(listId, aisle.name);
						} else {
							const aisle = r.pick(hidden);
							action = `show aisle ${aisle.name}`;
							await d.showAisle(listId, aisle.name);
						}
					} else if (roll < 0.72) {
						action = 'clear purchase history';
						await d.clearHistory(listId);
					} else if (roll < 0.79) {
						if (offline.has(d)) {
							action = 'online';
							offline.delete(d);
							d.online();
						} else {
							action = 'offline';
							offline.add(d);
							d.offline();
						}
					} else if (roll < 0.83) {
						const path = r.pick(FAULTED);
						const kind = r.next() < 0.5 ? 'lost-response' : 'server-error';
						action = `fault ${kind} on next ${path.source}`;
						d.fail(path, kind);
					} else if (roll < 0.85) {
						action = 'server sweeps removed rows';
						const taken = await world.sweep(listId, devices);
						const left = new Set((await world.serverView(listId)).items.map((i) => key(i.name)));
						for (const name of taken) if (!left.has(key(name))) written.swept.add(key(name));
						if (taken.length) action += `: ${taken.join(', ')}`;
					} else if (roll < 0.88) {
						const others = devices.filter((x) => x !== d && r.next() < 0.5);
						action = `sync ${[d, ...others].map((x) => x.label).join(' + ')} together`;
						await Promise.all([d, ...others].map((x) => x.trySync()));
					} else if (roll < 0.9) {
						action = 'server sends realtime events';
						await world.broadcast(
							listId,
							devices.filter((x) => !offline.has(x))
						);
					} else if (roll < 0.93) {
						action = `hears ${await d.hear()} realtime events`;
					} else if (roll < 0.94) {
						if (expired.has(d)) {
							action = 'sign back in';
							expired.delete(d);
							await d.signBackIn();
						} else {
							action = 'session expires';
							expired.add(d);
							d.expireSession();
						}
					} else {
						action = 'sync';
						await d.trySync();
					}
				} catch (e) {
					// A step can race a merge (the name it picked just merged away) —
					// that is the person tapping a row that vanished, not an engine
					// failure. Log it; the oracle below is what judges the engine.
					action += ` (skipped: ${(e as Error).message})`;
				}
				await wire;
				if (action) log.push(`${step}: ${d.label} ${action}`);
				if (TRACE && action) {
					log.push(
						`    server ${TRACE}: ${(await world.serverRowsNamed(listId, TRACE)).join(' ') || '-'}`
					);
					for (const x of devices) {
						log.push(
							`    ${x.label} ${TRACE}: ${(await x.rowsNamed(listId, TRACE)).join(' ') || '-'}`
						);
					}
				}
			}

			// Everyone reconnects, faults clear, and everything settles.
			for (const d of devices) {
				d.online();
				d.clearFaults();
				if (expired.has(d)) await d.signBackIn();
				await d.hear();
			}
			for (let round = 0; round < 3; round++) await world.settle(...devices);
			if (TRACE) {
				log.push(
					`settled: server ${TRACE}: ${(await world.serverRowsNamed(listId, TRACE)).join(' ')}`
				);
			}

			const context = `seed ${seed}; replay with STRESS_SEEDS=${seed}\n${log.join('\n')}`;
			const server = await world.serverView(listId);

			// 1. convergence
			for (const d of devices) {
				expect(await d.view(listId), `${d.label} converged — ${context}`).toEqual(server);
				expect(await d.unsynced(), `${d.label} has nothing left unsynced — ${context}`).toBe(0);
			}
			// 2. no loss
			const onServer = new Set(server.items.map((i) => key(i.name)));
			for (const name of written.added) {
				if (written.renamedFrom.has(name) || written.swept.has(name)) continue;
				expect(onServer.has(name), `"${name}" was added and must not be lost — ${context}`).toBe(
					true
				);
			}
			// 3. no phantoms
			for (const name of onServer) {
				expect(
					written.added.has(name) || written.renamedTo.has(name),
					`"${name}" is on the server but nobody added it — ${context}`
				).toBe(true);
			}
			// 4. no duplicate living rows
			const shownNames = names(server).map(key);
			expect(shownNames, `one living row per name — ${context}`).toEqual([...new Set(shownNames)]);
			// 5. no invented values
			for (const it of server.items) {
				expect(
					typed(written, written.quantity, it.name, it.quantity),
					`"${it.name}" quantity "${it.quantity}" was typed by someone — ${context}`
				).toBe(true);
				expect(
					typed(written, written.note, it.name, it.note),
					`"${it.name}" note "${it.note}" was typed by someone — ${context}`
				).toBe(true);
			}
		}, 120_000);
	}
});
