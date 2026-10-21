// mountSync binds SSE to the list on screen and retries a failed subscription
// after the next completed cycle ([D-164]), and fetches each list's roster once
// per session (§7.4 trigger (a)).
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

const syncMocks = vi.hoisted(() => ({
	subscribe: vi.fn(),
	startSyncLoop: vi.fn(),
	syncNow: vi.fn(),
	runSyncCycle: vi.fn(),
	refreshRoster: vi.fn()
}));

vi.mock('./sse', () => ({ subscribe: syncMocks.subscribe }));
vi.mock('./loop', () => ({ startSyncLoop: syncMocks.startSyncLoop, syncNow: syncMocks.syncNow }));
vi.mock('./cycle', () => ({ runSyncCycle: syncMocks.runSyncCycle }));
vi.mock('./roster', () => ({ refreshRoster: syncMocks.refreshRoster }));

import { mountSync, pullFromServer, setActiveList, unmountSync } from './mount';
import { putMyList, resetDb } from '#lib/test-kit/db.js';

// A list just made or joined is "not found" until a pull brings it in.
describe('pullFromServer', () => {
	it('asks the loop for a cycle when its pull fails, and resolves anyway', async () => {
		syncMocks.runSyncCycle.mockRejectedValueOnce(new Error('offline'));
		await expect(pullFromServer()).resolves.toBeUndefined();
		expect(syncMocks.syncNow).toHaveBeenCalledOnce();
	});
});

describe('active-list realtime subscription', () => {
	beforeEach(async () => {
		unmountSync();
		await setActiveList(null);
		vi.clearAllMocks();
		syncMocks.startSyncLoop.mockReturnValue(vi.fn());
		syncMocks.refreshRoster.mockResolvedValue(undefined);
	});

	afterEach(async () => {
		unmountSync();
		await setActiveList(null);
	});

	it('retries a failed initial subscription after the next successful full cycle', async () => {
		const unsubscribe = vi.fn().mockResolvedValue(undefined);
		syncMocks.subscribe.mockRejectedValueOnce(new Error('offline'));

		await setActiveList('list-1');
		expect(syncMocks.subscribe).toHaveBeenCalledTimes(1);

		mountSync({});
		const options = syncMocks.startSyncLoop.mock.calls[0][0] as {
			onCycle: () => void;
		};
		syncMocks.subscribe.mockResolvedValueOnce(unsubscribe);
		options.onCycle();

		await vi.waitFor(() => expect(syncMocks.subscribe).toHaveBeenCalledTimes(2));
		await setActiveList(null);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe('roster refresh (§7.4 trigger (a))', () => {
	beforeEach(async () => {
		unmountSync();
		await resetDb();
		vi.clearAllMocks();
		syncMocks.startSyncLoop.mockReturnValue(vi.fn());
		syncMocks.refreshRoster.mockResolvedValue(undefined);
	});

	afterEach(() => unmountSync());

	const cycle = () => {
		const options = syncMocks.startSyncLoop.mock.calls[0][0] as { onCycle: () => void };
		options.onCycle();
	};
	const fetched = () => syncMocks.refreshRoster.mock.calls.map(([list]) => list as string);

	it('fetches a list joined after the session’s first cycle, once', async () => {
		await putMyList('list-1', 'Groceries');
		mountSync({});
		cycle();
		await vi.waitFor(() => expect(fetched()).toEqual(['list-1']));

		await putMyList('list-2', 'Pharmacy');
		cycle();
		await vi.waitFor(() => expect(fetched()).toEqual(['list-1', 'list-2']));

		cycle();
		await new Promise((done) => setTimeout(done, 20));
		expect(fetched()).toEqual(['list-1', 'list-2']);
	});

	it('retries a failed fetch on the next cycle', async () => {
		await putMyList('list-1', 'Groceries');
		syncMocks.refreshRoster.mockRejectedValueOnce(new Error('offline'));
		mountSync({});
		cycle();
		await vi.waitFor(() => expect(fetched()).toEqual(['list-1']));
		await new Promise((done) => setTimeout(done, 20));

		cycle();
		await vi.waitFor(() => expect(fetched()).toEqual(['list-1', 'list-1']));
	});
});
