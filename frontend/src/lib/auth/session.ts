// The account-session generation (§5.6 [D-109]): "is the account this work
// belongs to still the one signed in here?". Async work takes a sessionScope()
// before it starts and asks scope.owned() immediately BEFORE each write, not at
// entry, so nothing writes behind a sign-out's wipe. For a Dexie write, ask
// inside the transaction: the wipe's transaction cannot interleave there.
//
// A session is an AbortSignal, aborted when it ends: its requests pass it to
// fetch and are cancelled with it. Sign-out crosses tabs over a
// BroadcastChannel; a remote sign-out ends this tab's session too.
// A sign-in crosses them too: the tabs share the stored token and the local
// mirror, so a browser profile holds one account at a time ([D-109]), and a
// tab on another account, or on none, takes up the new one.

let session = new AbortController();

function endHere(): void {
	session.abort();
	session = new AbortController();
}

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
			endHere();
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

/** A captured session: `owned()` stays true, and `signal` unaborted, until that session ends. */
export interface SessionScope {
	owned(): boolean;
	signal: AbortSignal;
}

/** Capture the live session, before the first await of the work it guards. */
export function sessionScope(): SessionScope {
	const { signal } = session;
	return { owned: () => !signal.aborted, signal };
}

/**
 * End the account session HERE and in every other tab. Called first thing in
 * `logout()`, before the store is cleared and the Dexie wipe starts, so all
 * in-flight work is disowned before it could write behind the wipe.
 */
export function endSession(): void {
	endHere();
	sessionChannel().postMessage({ type: 'ended' });
}

/**
 * Register a teardown to run when ANOTHER tab ends the session. This tab's
 * session has already ended when it fires.
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
	// Work a previous test left running ends with its session.
	session.abort();
	session = new AbortController();
	remoteListeners.clear();
	startListeners.clear();
	channel?.close();
	channel = null;
}
