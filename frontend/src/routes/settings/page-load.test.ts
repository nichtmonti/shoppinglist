// The settings route's passkey read ([D-205]). On a cold start the session
// comes back from IndexedDB after the router has called `load`, and asked
// without it the server answers an empty list: the group then said "no
// passkeys" to an account with one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { session, listPasskeys } = vi.hoisted(() => {
	let restore!: () => void;
	const session = {
		valid: false,
		restored: Promise.resolve<void>(undefined),
		/** A cold start: the token arrives when `restore()` is called. */
		coldStart(): () => void {
			session.restored = new Promise<void>((r) => (restore = r));
			return () => {
				session.valid = true;
				restore();
			};
		}
	};
	return { session, listPasskeys: vi.fn() };
});

vi.mock('#lib/pb.js', () => ({
	get initialToken() {
		return session.restored;
	},
	pb: {
		authStore: {
			get isValid() {
				return session.valid;
			}
		}
	}
}));
vi.mock('#lib/actions/account.js', () => ({ listPasskeys }));
vi.mock('#lib/state/auth-methods.js', async () => {
	const { readable } = await import('svelte/store');
	return { authMethods: readable(null) };
});
vi.mock('#lib/state/data.js', () => ({
	preloadSettings: vi.fn().mockResolvedValue(undefined),
	capped: <T>(read: Promise<T>) => read
}));

import { load } from './+page';

const run = () => load({} as Parameters<typeof load>[0]) as Promise<{ passkeys: unknown }>;

beforeEach(() => {
	session.valid = false;
	session.restored = Promise.resolve();
	listPasskeys.mockReset().mockResolvedValue([{ id: 'c1', friendly_name: '', last_used_at: null }]);
});

describe('settings load', () => {
	it('asks for the passkeys only once the session is restored', async () => {
		const restore = session.coldStart();
		const loading = run();
		await Promise.resolve();
		expect(listPasskeys).not.toHaveBeenCalled();

		restore();
		expect((await loading).passkeys).toHaveLength(1);
	});

	it('leaves them to the group when signed out', async () => {
		expect((await run()).passkeys).toBeNull();
		expect(listPasskeys).not.toHaveBeenCalled();
	});
});
