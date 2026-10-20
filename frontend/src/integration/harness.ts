// Two-client harness: real backend binary, real client sync modules, no fakes
// on either side of the wire.
//
// The client modules are singletons (`db`, `pb`), so a second "client" in the
// same process needs a second module graph. vi.resetModules() gives us that, and
// swapping globalThis.indexedDB first gives each graph its own IndexedDB backing
// store — Dexie snapshots the factory from `Dexie.dependencies` at module-eval
// time and again per instance in its constructor, and both clients open the same
// database NAME ('einkaufsliste_sync'), so the factory swap is what actually
// separates them.
import PocketBase from 'pocketbase';
import { v4 } from 'uuid';
import { vi } from 'vitest';

import { BASE_URL, SUPERUSER_EMAIL, SUPERUSER_PASSWORD } from './config';

type DbModule = typeof import('#lib/db.js');
type PbModule = typeof import('#lib/pb.js');
type OutboxModule = typeof import('#lib/sync/outbox.js');
type PushModule = typeof import('#lib/sync/push.js');
type DigestModule = typeof import('#lib/sync/digest.js');
type SnapshotModule = typeof import('#lib/sync/snapshot.js');
type CycleModule = typeof import('#lib/sync/cycle.js');
type MirrorModule = typeof import('#lib/sync/mirror.js');
type RecordModule = typeof import('#lib/sync/record.js');
type CategoriesModule = typeof import('#lib/actions/categories.js');

export interface Account {
	id: string;
	nickname: string;
	token: string;
}

export interface Client {
	account: Account;
	db: DbModule['db'];
	pb: PbModule['pb'];
	outbox: OutboxModule;
	push: PushModule;
	digest: DigestModule;
	snapshot: SnapshotModule;
	cycle: CycleModule;
	mirror: MirrorModule;
	record: RecordModule;
	// The app's own category actions, bound to THIS client's db/outbox: the
	// category editor's writes go through them, so a test that hand-built the op
	// would only prove the shape the test author remembered.
	categories: CategoriesModule;
	// The digest probe the cycle runs, as one call: the server digest, this
	// client's local digests, and the lists where they differ.
	probe: () => Promise<{
		diverged: string[];
		server: Awaited<ReturnType<DigestModule['fetchServerDigest']>>;
		local: Awaited<ReturnType<DigestModule['localDigests']>>;
	}>;
	close: () => void;
}

// Record ids (items, categories) are client-generated (§8.2 outbox) with
// uuid's v4() — so the harness's are too. (List ids are minted by the
// server, [D-08].) Using PocketBase-shaped ids here instead would hide any
// id-format assumption on the server, which is exactly the class of drift this
// suite exists to catch.
export function newId(): string {
	return v4();
}

// Authenticated once and reused for the whole run. PocketBase's own rate
// limiter is on from first boot (migrations/1778000004) and its default
// `*:auth` rule is 2 requests per 3 seconds — a per-scenario superuser login
// blows straight through that and the suite fails with 429s that have nothing
// to do with what it is testing. Superuser-authed requests skip the limiter
// entirely (apis/middlewares_rate_limit.go skipRateLimit), so it is only the
// login itself that has to be rationed. The token outlives the run.
let adminPromise: Promise<PocketBase> | undefined;

export function adminClient(): Promise<PocketBase> {
	adminPromise ??= (async () => {
		const admin = new PocketBase(BASE_URL);
		await admin.collection('_superusers').authWithPassword(SUPERUSER_EMAIL, SUPERUSER_PASSWORD);
		return admin;
	})();
	return adminPromise;
}

// Create an account and mint a bearer token for it. Accounts are passkey-only
// (password auth is disabled in the migration), so there is no login to script;
// superuser impersonation is PocketBase's supported way to obtain a record token
// out of band, and it yields exactly the token shape the passkey routes issue.
export async function createAccount(admin: PocketBase, nickname: string): Promise<Account> {
	const handle = `${nickname.toLowerCase()}${Math.random().toString(36).slice(2, 10)}`;
	const password = `pw-${Math.random().toString(36).slice(2)}`;
	const rec = await admin.collection('accounts').create({
		handle,
		nickname,
		password,
		passwordConfirm: password
	});
	const impersonated = await admin.collection('accounts').impersonate(rec.id, 3600);
	return { id: rec.id, nickname, token: impersonated.authStore.token };
}

/**
 * A fresh client module graph — its own `db` on its own IndexedDB, its own
 * `pb` pointed at the test server and signed in with `token` — with `load`'s
 * modules imported into it. Every simulated client is built through this.
 */
export async function freshClientGraph<T>(
	token: string,
	load: () => Promise<T>
): Promise<{ pbMod: PbModule; modules: T }> {
	vi.resetModules();
	const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
	globalThis.indexedDB = new IDBFactory();
	globalThis.IDBKeyRange = IDBKeyRange;

	const [pbMod, modules] = await Promise.all([import('#lib/pb.js'), load()]);
	pbMod.pb.baseURL = BASE_URL;
	// AsyncAuthStore applies its `initial` promise through an internal queue; wait
	// for that to resolve before writing, so the token we set is the final one.
	await pbMod.initialToken;
	pbMod.pb.authStore.save(token);
	return { pbMod, modules };
}

export async function makeClient(account: Account): Promise<Client> {
	const {
		pbMod,
		modules: [dbMod, outbox, push, digest, snapshot, cycle, mirror, record, categories]
	} = await freshClientGraph(account.token, () =>
		Promise.all([
			import('#lib/db.js'),
			import('#lib/sync/outbox.js'),
			import('#lib/sync/push.js'),
			import('#lib/sync/digest.js'),
			import('#lib/sync/snapshot.js'),
			import('#lib/sync/cycle.js'),
			import('#lib/sync/mirror.js'),
			import('#lib/sync/record.js'),
			import('#lib/actions/categories.js')
		])
	);

	return {
		account,
		db: dbMod.db,
		pb: pbMod.pb,
		outbox,
		push,
		digest,
		snapshot,
		cycle,
		mirror,
		record,
		categories,
		probe: async () => {
			const [server, local] = await Promise.all([
				digest.fetchServerDigest(),
				digest.localDigests()
			]);
			return { ...digest.computeDivergence(local, server), server, local };
		},
		close: () => dbMod.db.close()
	};
}

// Create a list through the real §7.5 route (which also copies the category
// templates into list_categories) and add any extra members.
export async function createList(owner: Client, name = 'Owner'): Promise<string> {
	// [D-08] the server mints the id and returns the row; the harness reads it
	// back the same way the app does.
	const { id } = await owner.pb.send<{ id: string }>('/api/lists', {
		method: 'POST',
		body: { name }
	});
	return id;
}

export async function addMembership(
	admin: PocketBase,
	listId: string,
	account: Account
): Promise<void> {
	await admin.collection('memberships').create({ account: account.id, list: listId });
}

export async function removeMembership(
	admin: PocketBase,
	listId: string,
	account: Account
): Promise<void> {
	const rec = await admin
		.collection('memberships')
		.getFirstListItem(admin.filter('account = {:a} && list = {:l}', { a: account.id, l: listId }));
	await admin.collection('memberships').delete(rec.id);
}

// Read server state directly (superuser bypasses collection rules) for assertions
// that must not go through the client code under test.
export async function serverItems(
	admin: PocketBase,
	listId: string
): Promise<Record<string, unknown>[]> {
	return admin.collection('items').getFullList({
		filter: admin.filter('list = {:listId}', { listId })
	});
}

export async function serverItem(
	admin: PocketBase,
	recordId: string
): Promise<Record<string, unknown>> {
	return admin.collection('items').getOne(recordId);
}
