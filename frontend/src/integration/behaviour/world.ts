// The world the behaviour specs run in: simulated DEVICES against the real
// backend binary, described in the vocabulary of a person using the app —
// "add Milch", "go offline", "sync" — and read back as what that person sees.
//
// THIS IS THE ONLY FILE IN behaviour/ THAT KNOWS HOW SYNC WORKS. The specs next
// to it state outcomes — what every device and the server end up holding, and
// what each person was told — never how the engine gets there: no outbox, no
// digest, no op shapes. Replacing the sync engine means rewriting this file's
// `sync()` (and whatever storage `view()` reads); the specs must keep passing
// unchanged, and that is the point of them. Lint enforces the import rule
// (the layer matrix in eslint.shared.config.js).
//
// A device acts through the app's OWN actions (`#lib/actions/*`, the add box's
// `planAdd`), not hand-built ops, so a spec exercises what a tap does.
//
// Network: every request a device makes carries its bearer token, and the
// fetch wrapper below keys on it — so each device can be taken offline, given
// its own client address (PocketBase rate-limits per IP, and real phones have
// different ones), or handed injected faults, without the specs touching HTTP.
import PocketBase from 'pocketbase';

import { normalizeName } from '#lib/normalize.js';

import { adminClient, createAccount, freshClientGraph, type Account } from '../harness';

// ---- what a person sees -----------------------------------------------------

/** One row as the person experiences it. `removed` rows are not shown on the
 *  list; `bought` is whether the list remembers purchasing it (§6.10). */
export interface ItemView {
	name: string;
	quantity: string;
	note: string;
	aisle: string;
	state: 'active' | 'checked' | 'removed';
	bought: boolean;
}

export interface AisleView {
	name: string;
	hidden: boolean;
	order: number;
}

export interface ListView {
	items: ItemView[];
	aisles: AisleView[];
}

export interface ListEntry {
	id: string;
	name: string;
}

/** What the app told the person, independent of how the engine phrased it. */
export type Notice =
	| { kind: 'conflict'; item: string; field: string; mine: unknown; theirs: unknown }
	| { kind: 'removed-while-editing'; item: string }
	| { kind: 'refused'; item: string | null; field?: string; reason?: string }
	| { kind: 'list-gone'; list: string | null };

type Row = Record<string, unknown>;

// Row fields are scalars (text, number, bool, date strings); anything else is a
// projection bug worth seeing, not '[object Object]'.
const str = (v: unknown): string => {
	if (v === null || v === undefined) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return JSON.stringify(v);
};

/** The shared projection: server rows and device rows are judged by the same
 *  function, so "converged" means the person sees the same thing everywhere. */
export function project(items: Row[], categories: Row[]): ListView {
	const aisleName = (c: Row) => str(c.name) || str(c.slug);
	const byId = new Map(categories.map((c) => [str(c.id), c] as const));
	const others = categories.find((c) => c.slug === 'other');
	const view: ListView = {
		items: items
			.map((i) => {
				const cat = byId.get(str(i.category_key)) ?? others;
				return {
					name: str(i.name),
					quantity: str(i.quantity),
					note: str(i.note),
					aisle: cat ? aisleName(cat) : '',
					state: i.deleted_at ? 'removed' : i.checked ? 'checked' : 'active',
					bought: Boolean(i.last_bought_at)
				} satisfies ItemView;
			})
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		aisles: categories
			.map((c) => ({
				name: aisleName(c),
				hidden: Boolean(c.deleted_at),
				order: Number(c.sort_order)
			}))
			.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
	};
	return view;
}

/** The rows a person can actually see on the list (active and checked). */
export function shown(view: ListView): ItemView[] {
	return view.items.filter((i) => i.state !== 'removed');
}

/** Rows whose normalized name starts with `name`'s, one line each, for STRESS_TRACE. */
function traceRows(rows: Row[], name: string): string[] {
	return rows
		.filter((r) => normalizeName(str(r.name)).startsWith(normalizeName(name)))
		.map(
			(r) =>
				`${str(r.id).slice(0, 6)}:${JSON.stringify(str(r.name))}:` +
				`${r.deleted_at ? 'removed' : r.checked ? 'checked' : 'active'}` +
				`${r.last_bought_at ? '+bought' : ''}:q=${str(r.quantity)}`
		)
		.sort();
}

// ---- the network ------------------------------------------------------------

export type FaultKind =
	/** The request never reaches the server. */
	| 'unreachable'
	/** The server answers 503 without doing anything. */
	| 'server-error'
	/** The server does the work, then the answer is lost on the way back. */
	| 'lost-response';

interface Fault {
	path: RegExp;
	kind: FaultKind;
	remaining: number;
}

interface NetworkState {
	ip: string;
	offline: boolean;
	faults: Fault[];
}

const networks = new Map<string, NetworkState>();
let shimInstalled = false;

function authToken(init?: RequestInit): string | null {
	const h = init?.headers;
	let value: string | null = null;
	if (h instanceof Headers) value = h.get('Authorization');
	else if (Array.isArray(h))
		value = h.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null;
	else if (h) {
		const entry = Object.entries(h).find(([k]) => k.toLowerCase() === 'authorization');
		value = entry ? String(entry[1]) : null;
	}
	return value ? value.replace(/^Bearer\s+/i, '') : null;
}

function installShim(): void {
	if (shimInstalled) return;
	shimInstalled = true;
	const inner = globalThis.fetch;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const token = authToken(init);
		const net = token ? networks.get(token) : undefined;
		if (!net) return inner(input, init);
		if (net.offline) throw new TypeError('Failed to fetch (device offline)');

		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const fault = net.faults.find((f) => f.remaining > 0 && f.path.test(url));
		if (fault) fault.remaining--;
		if (fault?.kind === 'unreachable') throw new TypeError('Failed to fetch (injected)');
		if (fault?.kind === 'server-error') {
			return new Response('{"message":"injected"}', {
				status: 503,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const headers = new Headers(init?.headers);
		headers.set('X-Forwarded-For', net.ip);
		const response = await inner(input, { ...init, headers });
		if (fault?.kind === 'lost-response') {
			await response.arrayBuffer().catch(() => {}); // the server finished; drain it
			throw new TypeError('Failed to fetch (response lost, injected)');
		}
		return response;
	};
}

let nextIp = 1;

// PocketBase tokens are deterministic JWTs — same account, same expiry second,
// same string — so two devices of one person opened in the same second would
// share a token, and the network keyed on it would merge them: one device going
// offline would take the other down with it. A per-device lifetime makes every
// token unique.
let tokenSerial = 0;
async function uniqueToken(admin: PocketBase, account: Account): Promise<string> {
	const lifetime = 3600 + ++tokenSerial;
	return (await admin.collection('accounts').impersonate(account.id, lifetime)).authStore.token;
}

// ---- a device ---------------------------------------------------------------

type Modules = Awaited<ReturnType<typeof loadModules>>;

async function loadModules(token: string) {
	const { pbMod, modules } = await freshClientGraph(token, () =>
		Promise.all([
			import('#lib/db.js'),
			import('#lib/sync/cycle.js'),
			import('#lib/actions/items.js'),
			import('#lib/actions/lists.js'),
			import('#lib/actions/categories.js'),
			import('#lib/actions/invites.js'),
			import('#lib/components/add/add-model.js'),
			import('#lib/classify.js'),
			import('#lib/sorting.js'),
			import('#lib/test-kit/shadow-check.js'),
			import('#lib/sync/sse.js')
		])
	);
	const [
		dbMod,
		cycle,
		items,
		lists,
		categories,
		invites,
		addModel,
		classify,
		sorting,
		shadowCheck,
		sse
	] = modules;
	return {
		dbMod,
		pbMod,
		cycle,
		items,
		lists,
		categories,
		invites,
		addModel,
		classify,
		sorting,
		shadowCheck,
		sse
	};
}

/** The engine broke the shadow invariant — never a sync that merely did not finish. */
class ShadowDivergence extends Error {}

/** A realtime event on its way to a device (§8.5's SSE). */
interface ServerEvent {
	collection: 'items' | 'list_categories';
	record: Row;
	action: 'update' | 'delete';
}

export class Device {
	readonly notices: Notice[] = [];
	/** Realtime events sent and not yet arrived: they land when the device
	 *  hears them, however stale by then. */
	readonly inbox: ServerEvent[] = [];
	private readonly net: NetworkState;
	private token: string;

	private constructor(
		readonly label: string,
		readonly account: Account,
		private readonly m: Modules,
		private readonly admin: PocketBase,
		token: string
	) {
		this.token = token;
		this.net = {
			ip: `10.77.${Math.floor(nextIp / 250)}.${(nextIp % 250) + 1}`,
			offline: false,
			faults: []
		};
		nextIp++;
		networks.set(token, this.net);
	}

	static async open(label: string, account: Account, admin: PocketBase): Promise<Device> {
		installShim();
		// A distinct token per device, even for the same account: the network is
		// keyed on it, and two phones of one person are two devices.
		const token = await uniqueToken(admin, account);
		const m = await loadModules(token);
		return new Device(label, account, m, admin, token);
	}

	private get db() {
		return this.m.dbMod.db;
	}

	// ---- network and session ----

	offline(): void {
		this.net.offline = true;
	}

	online(): void {
		this.net.offline = false;
	}

	/** Inject a fault into the next `times` requests whose URL matches `path`. */
	fail(path: RegExp, kind: FaultKind, times = 1): void {
		this.net.faults.push({ path, kind, remaining: times });
	}

	/** Disarm every injected fault. */
	clearFaults(): void {
		this.net.faults.length = 0;
	}

	/** The server stops accepting this device's session (expiry, revocation). */
	expireSession(): void {
		const dead = `expired-${this.label}-${Math.random().toString(36).slice(2)}`;
		networks.set(dead, this.net);
		this.m.pbMod.pb.authStore.save(dead);
		this.token = dead;
	}

	/** The person signs back in (§5.8's one-tap re-auth). */
	async signBackIn(): Promise<void> {
		const token = await uniqueToken(this.admin, this.account);
		networks.set(token, this.net);
		this.m.pbMod.pb.authStore.save(token);
		this.token = token;
	}

	// ---- syncing: THE ENGINE-SPECIFIC PART ----

	/**
	 * Bring this device up to date with the server and deliver everything it
	 * has queued, as the app does between ticks. Throws if that cannot finish —
	 * offline, a failing server — leaving queued changes queued.
	 */
	async sync(): Promise<void> {
		if (this.net.offline) throw new Error(`${this.label} is offline`);
		const { cycle } = this.m;
		const deps = {
			drain: {
				onConflict: (n: import('#lib/sync/types.js').ConflictNotice) => void this.recordConflict(n),
				onGone: (_listId: string, name?: string) =>
					this.notices.push({ kind: 'list-gone', list: name || null }),
				onDenied: (n: import('#lib/sync/types.js').DeniedNotice) => void this.recordDenied(n)
			}
		};
		// A cycle delivers what was queued when it started; edits that settle into
		// a follow-up op (a coalesced change, a merged duplicate) need another.
		for (let round = 0; round < 4; round++) {
			try {
				await cycle.runSyncCycle(deps);
			} finally {
				await this.consistent('sync');
			}
			if ((await this.db.pending_ops.count()) === 0) return;
		}
		throw new Error(`${this.label}: ${await this.unsynced()} change(s) would not sync`);
	}

	/**
	 * The shadow invariant (docs/internals/design.md §8.2 step 0): every view row is what its
	 * shadow and queued ops make it, after every action and every cycle.
	 * Engine-specific, like `sync()`.
	 */
	private async consistent(after: string): Promise<void> {
		const divergence = await this.m.shadowCheck.shadowDivergence();
		if (divergence.length > 0) {
			throw new ShadowDivergence(
				`${this.label}: shadow diverged after ${after}:\n  ${divergence.join('\n  ')}`
			);
		}
	}

	/** Run one of the app's actions, then hold the device to the shadow invariant. */
	private async act<T>(name: string, action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} finally {
			await this.consistent(name);
		}
	}

	/** `sync()` that reports instead of throwing. */
	async trySync(): Promise<boolean> {
		try {
			await this.sync();
			return true;
		} catch (error) {
			if (error instanceof ShadowDivergence) throw error; // a broken invariant is not a failed sync
			return false;
		}
	}

	/** Changes made here that the server has not confirmed yet — the sync chip's count. */
	async unsynced(): Promise<number> {
		return this.db.pending_ops.count();
	}

	private async itemName(id: string): Promise<string> {
		const row = await this.db.items.get(id);
		return row ? row.name : '?';
	}

	private async recordConflict(n: import('#lib/sync/types.js').ConflictNotice): Promise<void> {
		const item = await this.itemName(n.record_id);
		if (n.kind === 'deleted_conflict') {
			this.notices.push({ kind: 'removed-while-editing', item });
			return;
		}
		for (const c of n.conflicts) {
			this.notices.push({ kind: 'conflict', item, field: c.field, mine: c.mine, theirs: c.theirs });
		}
	}

	private async recordDenied(n: import('#lib/sync/types.js').DeniedNotice): Promise<void> {
		// What the app SHOWS, not what the engine emits: a lost membership is not
		// reported as a failed change — the list-gone notice covers it
		// (#lib/state/sync-notices, [D-138]). Recording it here would test the engine's plumbing.
		if (n.reason === 'not_member') return;
		const row = await this.db.items.get(n.record_id);
		this.notices.push({
			kind: 'refused',
			item: row?.name ?? null,
			field: n.field,
			reason: n.reason
		});
	}

	/** The realtime events on their way arrive, oldest first. Returns how many. */
	async hear(): Promise<number> {
		const events = this.inbox.splice(0);
		for (const e of events) {
			await this.act('realtime event', () =>
				this.m.sse.applyEvent(e.collection, e.record, e.action)
			);
		}
		return events.length;
	}

	/** Raw local rows whose name starts with `name` as the server compares names
	 *  (a rename's lineage included), ids included — for tracing a failure, not asserting. */
	async rowsNamed(listId: string, name: string): Promise<string[]> {
		return traceRows((await this.rows(listId)) as unknown as Row[], name);
	}

	/** Notices raised since the last call. */
	takeNotices(): Notice[] {
		return this.notices.splice(0);
	}

	// ---- what this person sees ----

	async view(listId: string): Promise<ListView> {
		const [items, cats] = await Promise.all([
			this.db.items.where('list').equals(listId).toArray(),
			this.db.list_categories.where('list').equals(listId).toArray()
		]);
		return project(items as unknown as Row[], cats as unknown as Row[]);
	}

	async lists(): Promise<ListEntry[]> {
		const [rows, lists] = await Promise.all([
			this.db.memberships.toArray(),
			this.db.lists.toArray()
		]);
		const names = new Map(lists.map((l) => [l.id, l.name] as const));
		return rows
			.map((r) => ({ id: r.list, name: names.get(r.list) ?? '' }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** The ids of the items and aisles this device shows removed, items only
	 *  when it also shows them never bought: the rows the clean-up may take. */
	async sweepableIds(listId: string): Promise<Set<string>> {
		const [items, cats] = await Promise.all([
			this.db.items.where('list').equals(listId).toArray(),
			this.db.list_categories.where('list').equals(listId).toArray()
		]);
		return new Set(
			[...items.filter((r) => !r.last_bought_at), ...cats]
				.filter((r) => r.deleted_at)
				.map((r) => r.id)
		);
	}

	// ---- acting, through the app's own actions ----

	private async rows(listId: string) {
		return this.db.items.where('list').equals(listId).toArray();
	}

	private async livingRow(listId: string, name: string) {
		const matches = (await this.rows(listId)).filter(
			(i) => i.name === name && i.deleted_at === null
		);
		if (matches.length !== 1) {
			throw new Error(`${this.label}: expected one "${name}" on the list, found ${matches.length}`);
		}
		return matches[0];
	}

	async createList(name: string): Promise<string> {
		return this.m.lists.createList(name);
	}

	/** Mint an invite link's token (the share sheet). */
	async invite(listId: string): Promise<string> {
		const invite = await this.m.invites.createInvite(listId);
		if (!invite.token) throw new Error('invite without a token');
		return invite.token;
	}

	async join(token: string): Promise<string> {
		return this.m.lists.joinList(token);
	}

	async leave(listId: string): Promise<void> {
		await this.m.lists.leaveList(listId);
	}

	async renameList(listId: string, name: string): Promise<void> {
		await this.m.lists.renameList(listId, name);
	}

	async clearHistory(listId: string): Promise<void> {
		await this.act('clearHistory', () => this.m.lists.clearHistory(listId));
	}

	/** Type a name into the add box and commit it — dedup and aisle guess included. */
	async add(
		listId: string,
		name: string,
		fields: { quantity?: string; note?: string } = {}
	): Promise<void> {
		await this.act(`add ${name}`, () => this.addUnchecked(listId, name, fields));
	}

	private async addUnchecked(
		listId: string,
		name: string,
		fields: { quantity?: string; note?: string }
	): Promise<void> {
		const { addModel, classify, sorting, items: actions } = this.m;
		const all = await this.rows(listId);
		const scope = all.filter(sorting.livingOrRemembered);
		const categories = await this.db.list_categories.where('list').equals(listId).toArray();
		const dictionary = await this.db.item_dictionary.toArray();
		const corpus = classify.buildCorpus(dictionary, scope, categories, 'de');
		const plan = addModel.planAdd(name, null, scope, categories, corpus);
		if (plan.kind === 'existing') {
			await actions.applyDedupHit(plan.item);
			if (fields.quantity !== undefined || fields.note !== undefined) {
				await this.m.items.editItem(await this.livingRow(listId, plan.item.name), fields);
			}
			return;
		}
		await actions.addItem(listId, {
			name: plan.name,
			category_key: plan.categoryKey,
			quantity: fields.quantity,
			note: fields.note ?? null
		});
	}

	async edit(
		listId: string,
		name: string,
		fields: { name?: string; quantity?: string; note?: string }
	): Promise<void> {
		await this.act(`edit ${name}`, async () =>
			this.m.items.editItem(await this.livingRow(listId, name), fields)
		);
	}

	async check(listId: string, name: string): Promise<void> {
		await this.act(`check ${name}`, async () =>
			this.m.items.setChecked(await this.livingRow(listId, name), true)
		);
	}

	async uncheck(listId: string, name: string): Promise<void> {
		await this.act(`uncheck ${name}`, async () =>
			this.m.items.setChecked(await this.livingRow(listId, name), false)
		);
	}

	/** Take a tick back: its undo, or putting the item back from the done pile.
	 *  Not bought after all, unlike `uncheck` (a re-add: bought, needed again). */
	async takeBack(listId: string, name: string): Promise<void> {
		await this.act(`take back ${name}`, async () =>
			this.m.items.setChecked(await this.livingRow(listId, name), false, { notBought: true })
		);
	}

	async remove(listId: string, name: string): Promise<void> {
		await this.act(`remove ${name}`, async () =>
			this.m.items.removeItem(await this.livingRow(listId, name))
		);
	}

	/** Bring a checked or remembered item back onto the list ("Frühere Artikel"). */
	async restore(listId: string, name: string): Promise<void> {
		const rows = (await this.rows(listId)).filter(
			(i) => i.name === name && (i.checked || i.deleted_at !== null)
		);
		if (rows.length !== 1)
			throw new Error(`${this.label}: expected one "${name}" to restore, found ${rows.length}`);
		await this.act(`restore ${name}`, () => this.m.items.reactivate(rows[0]));
	}

	/** File the item under another aisle (the item sheet's aisle grid). */
	async move(listId: string, name: string, aisle: string): Promise<void> {
		await this.act(`move ${name}`, async () =>
			this.m.items.editItem(await this.livingRow(listId, name), {
				category_key: (await this.aisleRow(listId, aisle)).id
			})
		);
	}

	async renameAisle(listId: string, aisle: string, name: string): Promise<void> {
		await this.act(`rename aisle ${aisle}`, async () =>
			this.m.categories.editCategory(await this.aisleRow(listId, aisle), { name })
		);
	}

	async hideAisle(listId: string, aisle: string): Promise<void> {
		await this.act(`hide aisle ${aisle}`, async () =>
			this.m.categories.hideCategory(await this.aisleRow(listId, aisle), aisle)
		);
	}

	/** Bring a hidden aisle back (the category editor's hidden section). */
	async showAisle(listId: string, aisle: string): Promise<void> {
		await this.act(`show aisle ${aisle}`, async () =>
			this.m.categories.restoreCategory(await this.aisleRow(listId, aisle))
		);
	}

	private async aisleRow(listId: string, aisle: string) {
		const rows = (await this.db.list_categories.where('list').equals(listId).toArray()).filter(
			(c) => (c.name || c.slug) === aisle
		);
		if (rows.length !== 1)
			throw new Error(`${this.label}: expected one aisle "${aisle}", found ${rows.length}`);
		return rows[0];
	}

	close(): void {
		networks.delete(this.token);
		this.db.close();
	}
}

// ---- the world --------------------------------------------------------------

export interface Person {
	account: Account;
	/** Open another device signed in as this person. */
	device(label?: string): Promise<Device>;
}

export class World {
	private readonly devices: Device[] = [];

	private constructor(readonly admin: PocketBase) {}

	static async create(): Promise<World> {
		return new World(await adminClient());
	}

	async person(nickname: string): Promise<Person> {
		const account = await createAccount(this.admin, nickname);
		let n = 0;
		return {
			account,
			device: async (label = `${nickname}#${++n}`) => {
				const d = await Device.open(label, account, this.admin);
				this.devices.push(d);
				return d;
			}
		};
	}

	/** Another device signed in to an existing account (a second phone, a tablet). */
	async deviceFor(account: Account, label: string): Promise<Device> {
		const d = await Device.open(label, account, this.admin);
		this.devices.push(d);
		return d;
	}

	/** The server's truth, read with superuser rights around the code under test. */
	async serverView(listId: string): Promise<ListView> {
		const filter = this.admin.filter('list = {:l}', { l: listId });
		const [items, cats] = await Promise.all([
			this.admin.collection('items').getFullList({ filter }),
			this.admin.collection('list_categories').getFullList({ filter })
		]);
		return project(items, cats);
	}

	/**
	 * The server's daily clean-up with its 180 days taken as passed: removed
	 * items never bought, and hidden aisles, are deleted for good. With
	 * `seenBy`, only the rows each of those devices already shows as the
	 * clean-up finds them, as 180 days give every device in use the time to
	 * hear of it: a device still showing a purchase the history reset cleared
	 * would bring the row back on a re-add. Returns the
	 * names of the items it took.
	 */
	async sweep(listId: string, seenBy: Device[] = []): Promise<string[]> {
		const seen = await Promise.all(seenBy.map((d) => d.sweepableIds(listId)));
		const swept = async (collection: string, filter: string) => {
			const rows = (
				await this.admin.collection(collection).getFullList({
					filter: this.admin.filter(`list = {:l} && deleted_at != '' ${filter}`, { l: listId })
				})
			).filter((r) => seen.every((ids) => ids.has(r.id)));
			for (const r of rows) await this.admin.collection(collection).delete(r.id);
			for (const d of seenBy) {
				d.inbox.push(
					...rows.map((record) => ({
						collection: collection as ServerEvent['collection'],
						record,
						action: 'delete' as const
					}))
				);
			}
			return rows.map((r) => str(r.name));
		};
		await swept('list_categories', '');
		return swept('items', "&& last_bought_at = ''");
	}

	/** The server sends every row of the list as a realtime event to each
	 *  online device; each arrives when that device hears it. */
	async broadcast(listId: string, to: Device[]): Promise<void> {
		const filter = this.admin.filter('list = {:l}', { l: listId });
		const [items, cats] = await Promise.all([
			this.admin.collection('items').getFullList({ filter }),
			this.admin.collection('list_categories').getFullList({ filter })
		]);
		const events: ServerEvent[] = [
			...items.map((record) => ({
				collection: 'items' as const,
				record,
				action: 'update' as const
			})),
			...cats.map((record) => ({
				collection: 'list_categories' as const,
				record,
				action: 'update' as const
			}))
		];
		for (const d of to) d.inbox.push(...events);
	}

	/** `Device.rowsNamed` for the server's rows. */
	async serverRowsNamed(listId: string, name: string): Promise<string[]> {
		const filter = this.admin.filter('list = {:l}', { l: listId });
		return traceRows(await this.admin.collection('items').getFullList({ filter }), name);
	}

	async serverLists(account: Account): Promise<ListEntry[]> {
		const rows = await this.admin.collection('memberships').getFullList({
			filter: this.admin.filter('account = {:a}', { a: account.id }),
			expand: 'list'
		});
		return rows
			.map((r) => ({ id: String(r.list), name: String(r.expand?.list?.name ?? '') }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	async listExists(listId: string): Promise<boolean> {
		try {
			await this.admin.collection('lists').getOne(listId);
			return true;
		} catch {
			return false;
		}
	}

	/** Every online device syncs, twice round, so each sees what the others sent. */
	async settle(...devices: Device[]): Promise<void> {
		for (let round = 0; round < 2; round++) {
			for (const d of devices) await d.sync();
		}
	}

	close(): void {
		for (const d of this.devices.splice(0)) d.close();
	}
}
