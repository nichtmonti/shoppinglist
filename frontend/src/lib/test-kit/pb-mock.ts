// The one `#lib/pb.js` mock ([D-77], as auth-mock.ts is for `#lib/auth`).
//
// Every export of the real module is here, so a module under test that starts
// importing another one finds it; `pb-mock.test.ts` pins the list to pb.ts's
// runtime exports. A test names only what it drives: the auth store, the
// collections it touches, `send`, and any other `pb` member.
//
//	vi.mock('#lib/pb.js', async () => {
//		const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
//		return pbModuleMock({ collections: { accounts: { update: accountsUpdate } }, send: pbSend });
//	});
//
// The hoisted fns a test passes in are captured once per test FILE, so
// per-test `mockResolvedValue(...)` overrides keep working.
import { vi } from 'vitest';

export interface PbMockOptions {
	/** `pb.authStore` and the `authStore` export; by default account-1, signed in. */
	authStore?: { token?: string; record?: unknown };
	/** What `pb.collection(name)` returns; any other name throws. */
	collections?: Record<string, object>;
	/** `pb.send`; by default it rejects, as an unmocked call would fail. */
	send?: (...args: never[]) => unknown;
	initialToken?: Promise<unknown>;
	/** Further `pb` members: `filter`, `baseURL`, `cancelRequest`. */
	pb?: Record<string, unknown>;
}

export function pbModuleMock(options: PbMockOptions = {}): Record<string, unknown> {
	const authStore = options.authStore ?? { record: { id: 'account-1' }, token: 'tok' };
	const collections = options.collections ?? {};
	return {
		initialToken: options.initialToken ?? Promise.resolve(null),
		authStore,
		pb: {
			authStore,
			collection: (name: string) => {
				const collection = collections[name];
				if (!collection) throw new Error(`unmocked collection ${name}`);
				return collection;
			},
			send:
				options.send ??
				vi.fn(async (path: string) => {
					throw new Error(`unmocked pb.send ${path}`);
				}),
			...options.pb
		},
		// The real one, over the mocked store.
		authHeaders: (token: string = authStore.token ?? ''): Record<string, string> =>
			token ? { Authorization: `Bearer ${token}` } : {}
	};
}
