// §6.11 suggestion suppression's delivery to the account record ([D-137]).
// Real Dexie, fake #lib/pb: what matters is what reaches `accounts.update`,
// and what the mirror holds after each kind of failure.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accountsGetOne, accountsUpdate, authStore, showFailure } = vi.hoisted(() => ({
	accountsGetOne: vi.fn(),
	accountsUpdate: vi.fn(),
	authStore: { record: null as Record<string, unknown> | null, token: 'tok' },
	showFailure: vi.fn()
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		authStore,
		collections: { accounts: { getOne: accountsGetOne, update: accountsUpdate } }
	});
});
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({ showFailure })
);

import { db, getMeta } from '#lib/db.js';
import { wipeLocalAccountData } from '#lib/auth/account-data.js';
import { endSession } from '#lib/auth/session.js';
import { resetDb } from '#lib/test-kit/db.js';
import { loadLocale } from './prefs';
import {
	flushSuppressed,
	loadSuppressed,
	refreshSuppressedMirror,
	suppressName,
	unsuppressName
} from './suppression';

/** The server's copy of the account record, as the fake pb serves it. */
let server: string[];

function offline(): Error {
	return Object.assign(new Error('Failed to fetch'), { status: 0 });
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	server = [];
	authStore.record = { id: 'account-1', suppressed_names: [] };
	accountsGetOne.mockImplementation(async () => ({ id: 'account-1', suppressed_names: server }));
	accountsUpdate.mockImplementation(async (id: string, body: { suppressed_names: string[] }) => {
		server = [...body.suppressed_names];
		return { id, suppressed_names: server };
	});
});

describe('suggestion suppression delivery (§6.11, [D-137])', () => {
	it('suppresses locally at once and delivers it to the account', async () => {
		await suppressName('Butter');
		expect(await loadSuppressed()).toEqual(['butter']);
		await flushSuppressed();
		expect(server).toEqual(['butter']);
		expect(await getMeta('suppressed_pending')).toEqual({});
	});

	// The bug this replaced: the boot refresh overwrote the mirror with the
	// account record, so an offline suppression came back on the next start.
	it('an offline suppression survives the boot refresh and is delivered later', async () => {
		accountsGetOne.mockRejectedValue(offline());
		await suppressName('Butter');
		await flushSuppressed();
		expect(accountsUpdate).not.toHaveBeenCalled();

		// Next app start, still before the server has it: the record lacks it.
		await refreshSuppressedMirror();
		expect(await loadSuppressed()).toEqual(['butter']);

		accountsGetOne.mockImplementation(async () => ({ id: 'account-1', suppressed_names: server }));
		await flushSuppressed();
		expect(server).toEqual(['butter']);
		expect(await getMeta('suppressed_pending')).toEqual({});
	});

	it("merges into the account's current list instead of overwriting another device's names", async () => {
		await suppressName('Butter');
		await flushSuppressed();
		server = ['butter', 'senf']; // another device suppressed "Senf" meanwhile

		await suppressName('Milch');
		await unsuppressName('Butter');
		await flushSuppressed();
		expect(server).toEqual(['senf', 'milch']);
		expect(await loadSuppressed()).toEqual(['senf', 'milch']);
	});

	it('a refused write is dropped, the mirror falls back to the server copy, and the user is told', async () => {
		server = ['senf'];
		authStore.record = { id: 'account-1', suppressed_names: ['senf'] };
		accountsUpdate.mockRejectedValue(Object.assign(new Error('Bad Request'), { status: 400 }));

		await suppressName('Butter');
		expect(await loadSuppressed()).toEqual(['butter']);
		await flushSuppressed();

		expect(await getMeta('suppressed_pending')).toEqual({});
		expect(await loadSuppressed()).toEqual(['senf']);
		expect(showFailure).toHaveBeenCalledOnce();
	});

	it('an expired token keeps the change for the re-auth flush', async () => {
		accountsGetOne.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
		await suppressName('Butter');
		await flushSuppressed();
		expect(await getMeta('suppressed_pending')).toEqual({ butter: 'add' });
		expect(showFailure).not.toHaveBeenCalled();

		// Signed back in.
		accountsGetOne.mockImplementation(async () => ({ id: 'account-1', suppressed_names: server }));
		await flushSuppressed();
		expect(server).toEqual(['butter']);
	});

	it('a change made while a write is in flight is kept for the next one', async () => {
		let release!: () => void;
		accountsGetOne.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ id: 'account-1', suppressed_names: server });
				})
		);
		await suppressName('Butter'); // starts a flush that waits on the read
		await vi.waitFor(() => expect(accountsGetOne).toHaveBeenCalled());
		await suppressName('Senf');
		release();
		await flushSuppressed();

		expect(server).toEqual(['butter', 'senf']);
		expect(await getMeta('suppressed_pending')).toEqual({});
	});

	it('does nothing signed out, and keeps the change', async () => {
		authStore.record = null;
		await suppressName('Butter');
		await flushSuppressed();
		expect(accountsGetOne).not.toHaveBeenCalled();
		expect(await loadSuppressed()).toEqual(['butter']);
	});

	// [D-109]: sign-out bumps the session and wipes `meta` while the write is
	// still in flight; its answer belongs to the account that just left.
	it('a sign-out during the write leaves the wiped mirror alone', async () => {
		accountsUpdate.mockImplementation(async (id: string, body: { suppressed_names: string[] }) => {
			endSession();
			await wipeLocalAccountData();
			return { id, suppressed_names: body.suppressed_names };
		});
		await suppressName('Butter');
		await flushSuppressed();

		expect(await getMeta('suppressed_names')).toBeUndefined();
		expect(await getMeta('suppressed_pending')).toBeUndefined();
	});

	it('a refusal that lands after a sign-out is not toasted', async () => {
		accountsUpdate.mockImplementation(async () => {
			endSession();
			await wipeLocalAccountData();
			throw Object.assign(new Error('Bad Request'), { status: 400 });
		});
		await suppressName('Butter');
		await flushSuppressed();

		expect(showFailure).not.toHaveBeenCalled();
		expect(await getMeta('suppressed_names')).toBeUndefined();
	});

	// Every caller fires and forgets, so a rejection here is an unhandled one.
	it('a local storage failure is logged, not thrown', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const get = vi.spyOn(db.meta, 'get').mockRejectedValueOnce(new Error('IndexedDB gone'));
		try {
			await expect(flushSuppressed()).resolves.toBeUndefined();
			expect(error).toHaveBeenCalled();
		} finally {
			get.mockRestore();
			error.mockRestore();
		}
	});
});

// [D-293] Boot waits on the locale read; an IndexedDB that cannot be read must
// not leave a blank page.
describe('loadLocale', () => {
	it('falls back to the detected locale when the store cannot be read', async () => {
		const spy = vi.spyOn(db.meta, 'get').mockRejectedValueOnce(new Error('Connection lost'));
		await expect(loadLocale()).resolves.toBe('en');
		spy.mockRestore();
	});
});
