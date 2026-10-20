// The account-session generation (§5.6 [D-109]): "is the account this work
// belongs to still the one signed in here?". Async work takes a sessionScope()
// before it starts and asks scope.owned() immediately BEFORE each write, not at
// entry, so nothing writes behind a sign-out's wipe. For a Dexie write, ask
// inside the transaction: the wipe's transaction cannot interleave there.
//
// Sign-out crosses tabs over a BroadcastChannel. Each tab compares only its own
// counter with itself, so a remote sign-out just bumps this tab's counter.
// A sign-in crosses them too: the tabs share the stored token and the local
// mirror, so a browser profile holds one account at a time ([D-109]), and a
// tab on another account, or on none, takes up the new one.

let epoch = 0;

const CHANNEL = 'shoppinglist_session';
let channel: BroadcastChannel | null = null;
const remoteListeners = new Set<() => void>();
const startListeners = new Set<(accountId: string) => void>();

// Opened at first use, so the test seam can drop it. Never closed otherwise:
// closing it on the last listener would stop sign-outs reaching a tab that
// still has work in flight.
function sessionChannel(): BroadcastChannel {
	if (!channel) {
		channel = new BroadcastChannel(CHANNEL);
		channel.onmessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; id?: unknown } | null;
			if (data?.type === 'started' && typeof data.id === 'string' && data.id) {
				for (const listener of startListeners) listener(data.id);
				return;
			}
			if (data?.type !== 'ended') return;
			epoch++;
			for (const listener of remoteListeners) {
				try {
					listener();
				} catch {
					/* one listener must not stop the others from tearing down */
				}
			}
		};
	}
	return channel;
}

/** A captured session: `owned()` stays true until that session ends. */
export interface SessionScope {
	owned(): boolean;
}

/** Capture the live session, before the first await of the work it guards. */
export function sessionScope(): SessionScope {
	const captured = epoch;
	return { owned: () => captured === epoch };
}

/**
 * End the account session HERE and in every other tab. Called first thing in
 * `logout()`, before the store is cleared and the Dexie wipe starts, so all
 * in-flight work is disowned before it could write behind the wipe.
 */
export function endSession(): void {
	epoch++;
	sessionChannel().postMessage({ type: 'ended' });
}

/**
 * Register a teardown to run when ANOTHER tab ends the session. The epoch is
 * already bumped when it fires.
 */
export function onRemoteSessionEnd(listener: () => void): () => void {
	sessionChannel();
	remoteListeners.add(listener);
	return () => remoteListeners.delete(listener);
}

/**
 * Tell the other tabs that `accountId` is signed in here. Called once its
 * token is stored, so a tab that reloads on the news reads that account.
 */
export function announceSessionStart(accountId: string): void {
	sessionChannel().postMessage({ type: 'started', id: accountId });
}

/** Register a reaction to an account signed in in ANOTHER tab. */
export function onRemoteSessionStart(listener: (accountId: string) => void): () => void {
	sessionChannel();
	startListeners.add(listener);
	return () => startListeners.delete(listener);
}

/** Test seam: drop cross-tab state between cases. */
export function resetSessionForTest(): void {
	epoch = 0;
	remoteListeners.clear();
	startListeners.clear();
	channel?.close();
	channel = null;
}
