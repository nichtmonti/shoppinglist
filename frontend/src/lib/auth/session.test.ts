import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	announceSessionStart,
	endSession,
	onRemoteSessionEnd,
	onRemoteSessionStart,
	resetSessionForTest,
	sessionScope
} from './session';

// The cross-tab half of §5.6 [D-109]: signing out in one tab ends the session
// in every other tab of the device, disowning what they have in flight. A
// second BroadcastChannel on the same name stands in for the other tab, the
// way two tabs of one origin see each other.

const CHANNEL = 'shoppinglist_session';
const others: BroadcastChannel[] = [];

function otherTab(): BroadcastChannel {
	const c = new BroadcastChannel(CHANNEL);
	others.push(c);
	return c;
}

afterEach(() => {
	for (const c of others.splice(0)) c.close();
	resetSessionForTest();
});

describe('a sign-out in another tab', () => {
	it('disowns the work in flight here and runs the teardown', async () => {
		const teardown = vi.fn();
		onRemoteSessionEnd(teardown);
		const inFlight = sessionScope();

		otherTab().postMessage({ type: 'ended' });
		await vi.waitFor(() => expect(teardown).toHaveBeenCalledOnce());

		expect(inFlight.owned()).toBe(false);
		// The next session's work is its own again.
		expect(sessionScope().owned()).toBe(true);
	});

	it('runs every teardown even when one throws', async () => {
		const later = vi.fn();
		onRemoteSessionEnd(() => {
			throw new Error('teardown failed');
		});
		onRemoteSessionEnd(later);

		otherTab().postMessage({ type: 'ended' });
		await vi.waitFor(() => expect(later).toHaveBeenCalledOnce());
	});

	it('is the only message that ends anything', async () => {
		const teardown = vi.fn();
		onRemoteSessionEnd(teardown);
		const inFlight = sessionScope();

		const tab = otherTab();
		for (const message of [null, 'ended', { type: 'started' }, {}]) tab.postMessage(message);
		tab.postMessage({ type: 'ended' }); // delivered in order: after the four above
		await vi.waitFor(() => expect(teardown).toHaveBeenCalled());

		expect(teardown).toHaveBeenCalledOnce();
		expect(inFlight.owned()).toBe(false);
	});

	it('stops reaching a teardown once it is unregistered', async () => {
		const gone = vi.fn();
		const kept = vi.fn();
		onRemoteSessionEnd(gone)();
		onRemoteSessionEnd(kept);

		otherTab().postMessage({ type: 'ended' });
		await vi.waitFor(() => expect(kept).toHaveBeenCalledOnce());
		expect(gone).not.toHaveBeenCalled();
	});
});

describe('a sign-out in this tab', () => {
	it('disowns the work here at once and tells the other tabs', async () => {
		const heard: unknown[] = [];
		otherTab().onmessage = (e: MessageEvent) => heard.push(e.data);
		const ownTeardown = vi.fn();
		onRemoteSessionEnd(ownTeardown);
		const inFlight = sessionScope();

		endSession();
		expect(inFlight.owned()).toBe(false); // synchronously, before any await

		await vi.waitFor(() => expect(heard).toEqual([{ type: 'ended' }]));
		// No echo: the remote teardown is for the OTHER tabs. This one's
		// logout() clears its own auth itself.
		expect(ownTeardown).not.toHaveBeenCalled();
	});

	// [D-341] Its requests pass the session's signal to fetch: they are
	// cancelled with it, and the next session's work starts unaborted.
	it('aborts the session signal, and the next session has a fresh one', () => {
		const inFlight = sessionScope();
		endSession();
		expect(inFlight.signal.aborted).toBe(true);
		expect(sessionScope().signal.aborted).toBe(false);
	});
});

// A sign-in crosses tabs too ([D-109]): the tabs share the stored token and
// the mirror, so one account per browser profile.
describe('a sign-in', () => {
	it('in another tab names its account here, and ends nothing', async () => {
		const started = vi.fn();
		onRemoteSessionStart(started);
		const inFlight = sessionScope();

		const tab = otherTab();
		tab.postMessage({ type: 'started' });
		tab.postMessage({ type: 'started', id: 'acc-2' });
		await vi.waitFor(() => expect(started).toHaveBeenCalled());

		expect(started.mock.calls).toEqual([['acc-2']]);
		expect(inFlight.owned()).toBe(true);
	});

	it('here is told to the other tabs, not to this one', async () => {
		const heard: unknown[] = [];
		otherTab().onmessage = (e: MessageEvent) => heard.push(e.data);
		const own = vi.fn();
		onRemoteSessionStart(own);

		announceSessionStart('acc-1');

		await vi.waitFor(() => expect(heard).toEqual([{ type: 'started', id: 'acc-1' }]));
		expect(own).not.toHaveBeenCalled();
	});
});
