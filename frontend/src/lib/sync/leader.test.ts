import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestLeadership, type LocksAPI } from './leader';

describe('leader election', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('no locks API → loop runs ungated, cancel is a no-op', () => {
		const loop = vi.fn();
		const cancel = requestLeadership(loop, {});
		expect(loop).toHaveBeenCalledTimes(1);
		expect(cancel).toBeInstanceOf(Function);
		// Calling cancel should not throw
		expect(() => cancel()).not.toThrow();
	});

	it('with a fake locks API → loop runs while the lock is held; cancel releases', async () => {
		const loop = vi.fn();
		// Held in its own binding rather than asserted as fakeLocks.request: reading a method
		// off the object detaches it from its receiver (@typescript-eslint/unbound-method).
		const request = vi.fn(async (_name: string, cb: () => Promise<void>) => {
			await cb();
		});
		const fakeLocks: LocksAPI = { request };

		const cancel = requestLeadership(loop, { locks: fakeLocks });
		// The loop should have been called (callback resolves immediately)
		expect(loop).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith('sync-leader', expect.any(Function));

		// Cancel should be a no-op since the lock is already released
		expect(() => cancel()).not.toThrow();
	});
});

// Two tabs, one outbox: what leadership exists for (§8.7). The lock manager
// below grants one exclusive lock at a time, in request order, and frees it
// when the holder's callback settles, fulfilled or rejected, as the Web Locks
// API does. Like navigator.locks.request, the promise it returns rejects with
// the callback's rejection, and nothing here handles that for the caller.
function fifoLocks(): LocksAPI {
	let tail = Promise.resolve();
	return {
		request(_name, callback) {
			const held = tail.then(callback);
			tail = held.catch(() => {});
			return held.then(() => {});
		}
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('leadership across tabs', () => {
	it('one tab leads; the next starts only after it hands over', async () => {
		const locks = fifoLocks();
		const events: string[] = [];
		const cancelA = requestLeadership(() => events.push('A leads'), {
			locks,
			onRelease: () => void events.push('A released')
		});
		requestLeadership(() => events.push('B leads'), { locks });
		await settle();
		expect(events).toEqual(['A leads']);

		cancelA();
		await settle();
		expect(events).toEqual(['A leads', 'A released', 'B leads']);
	});

	it("the next leader waits for the last one's teardown to finish", async () => {
		const locks = fifoLocks();
		const events: string[] = [];
		let finishDrain!: () => void;
		const cancelA = requestLeadership(() => {}, {
			locks,
			onRelease: () =>
				new Promise<void>((resolve) => {
					events.push('A draining');
					finishDrain = () => {
						events.push('A drained');
						resolve();
					};
				})
		});
		requestLeadership(() => events.push('B leads'), { locks });
		await settle(); // A holds the lock

		cancelA();
		await settle();
		expect(events).toEqual(['A draining']); // B must not settle the outbox beside A's drain

		finishDrain();
		await settle();
		expect(events).toEqual(['A draining', 'A drained', 'B leads']);
	});

	// The lock is freed either way; what the swallow prevents is the request's
	// rejection going unhandled, which vitest fails the run on as a browser
	// would report it.
	it('a failed teardown still hands leadership over, quietly', async () => {
		const locks = fifoLocks();
		const bLeads = vi.fn();
		const teardown = vi.fn(() => Promise.reject(new Error('drain failed')));
		const cancelA = requestLeadership(() => {}, { locks, onRelease: teardown });
		requestLeadership(bLeads, { locks });
		await settle(); // A holds the lock

		cancelA();
		await vi.waitFor(() => expect(bLeads).toHaveBeenCalledOnce());
		expect(teardown).toHaveBeenCalledOnce();
	});

	it('a tab that gives up while waiting never leads, and does not block the queue', async () => {
		const locks = fifoLocks();
		const bLeads = vi.fn();
		const cLeads = vi.fn();
		const cancelA = requestLeadership(() => {}, { locks });
		const cancelB = requestLeadership(bLeads, { locks });
		requestLeadership(cLeads, { locks });
		await settle(); // A holds the lock

		cancelB(); // closed while A still leads
		cancelA();
		await vi.waitFor(() => expect(cLeads).toHaveBeenCalledOnce());
		expect(bLeads).not.toHaveBeenCalled();
	});

	it('a loop that throws on start still holds the lock until released', async () => {
		const locks = fifoLocks();
		const bLeads = vi.fn();
		const cancelA = requestLeadership(
			() => {
				throw new Error('start failed');
			},
			{ locks }
		);
		requestLeadership(bLeads, { locks });
		await settle();
		expect(bLeads).not.toHaveBeenCalled();

		cancelA();
		await vi.waitFor(() => expect(bLeads).toHaveBeenCalledOnce());
	});
});
