import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (e: { action: string; record: Record<string, unknown> }) => void;

// Stands in for pb.collection(name).subscribe; each test installs its own.
let subscribeImpl: (name: string, listener: Listener) => Promise<() => Promise<void>>;
vi.mock('../pb', () => ({
	pb: {
		filter: (expr: string) => expr,
		collection: (name: string) => ({
			subscribe: (_topic: string, listener: Listener) => subscribeImpl(name, listener)
		})
	}
}));

const { subscribe } = await import('./sse');
const { db } = await import('../db');
const { resetDb } = await import('#lib/test-kit/db.js');
const { endSession, resetSessionForTest } = await import('../auth/session');

describe('subscribe()', () => {
	let unsubItems: ReturnType<typeof vi.fn<() => Promise<void>>>;
	let unsubCats: ReturnType<typeof vi.fn<() => Promise<void>>>;
	beforeEach(() => {
		unsubItems = vi.fn(async () => {});
		unsubCats = vi.fn(async () => {});
	});

	it('a failed categories subscription takes the items one down with it', async () => {
		subscribeImpl = (name) =>
			name === 'items' ? Promise.resolve(unsubItems) : Promise.reject(new Error('connect failed'));

		await expect(subscribe('list-1')).rejects.toThrow('connect failed');
		expect(unsubItems).toHaveBeenCalledOnce();
	});

	it('the returned unsubscribe tears down both collections', async () => {
		subscribeImpl = (name) => Promise.resolve(name === 'items' ? unsubItems : unsubCats);

		await (
			await subscribe('list-1')
		)();
		expect(unsubItems).toHaveBeenCalledOnce();
		expect(unsubCats).toHaveBeenCalledOnce();
	});

	// The server filters events by list; this is the client's second line of
	// defence for the day it stops (sse.ts). An event for another list must not
	// reach this list's rows, whichever shape the relation arrives in.
	it('applies only the events of its own list', async () => {
		await resetDb();
		const listeners = new Map<string, Listener>();
		subscribeImpl = (name, listener) => {
			listeners.set(name, listener);
			return Promise.resolve(name === 'items' ? unsubItems : unsubCats);
		};
		await subscribe('list-1');

		const item = (id: string, list: string) => ({
			id,
			list,
			name: id,
			quantity: '',
			checked: false,
			updated: '2024-01-01T00:00:00.000Z',
			created: '2024-01-01T00:00:00.000Z',
			deleted_at: null
		});
		listeners.get('items')!({ action: 'create', record: item('foreign', 'list-2') });
		listeners.get('items')!({ action: 'create', record: item('own', 'list-1') });
		const category = (id: string, list: string) => ({
			id,
			list,
			name: id,
			sort_order: 1,
			updated: '2024-01-01T00:00:00.000Z'
		});
		listeners.get('list_categories')!({
			action: 'create',
			record: category('cat-foreign', 'list-2')
		});
		listeners.get('list_categories')!({ action: 'create', record: category('cat-own', 'list-1') });

		// Each collection's events apply in order, so once its own row is in,
		// the foreign ones before it have been decided.
		await vi.waitFor(async () => {
			expect(await db.items.get('own')).toBeDefined();
			expect(await db.list_categories.get('cat-own')).toBeDefined();
		});
		expect(await db.items.get('foreign')).toBeUndefined();
		expect(await db.list_categories.get('cat-foreign')).toBeUndefined();
	});

	// §5.6 [D-109]: PocketBase keeps the stream open across a sign-out until it
	// is unsubscribed, so an event arriving after one belongs to the account
	// that subscribed, not to whoever is signed in by then.
	it('applies nothing that arrives after a sign-out', async () => {
		await resetDb();
		const listeners = new Map<string, Listener>();
		subscribeImpl = (name, listener) => {
			listeners.set(name, listener);
			return Promise.resolve(name === 'items' ? unsubItems : unsubCats);
		};
		try {
			await subscribe('list-1');
			endSession();
			listeners.get('items')!({
				action: 'create',
				record: {
					id: 'late',
					list: 'list-1',
					name: 'Too late',
					quantity: '',
					checked: false,
					updated: '2024-01-01T00:00:00.000Z',
					created: '2024-01-01T00:00:00.000Z',
					deleted_at: null
				}
			});
			// The event's write runs in its own transaction; let it settle.
			await new Promise((r) => setTimeout(r, 50));
			expect(await db.items.get('late')).toBeUndefined();
		} finally {
			resetSessionForTest();
		}
	});
});
