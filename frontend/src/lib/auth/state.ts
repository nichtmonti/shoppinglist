// The auth-state store, kept apart from index.ts so writers (sync/push on a
// 401) do not pull in its top-level pb.authStore.onChange registration. This
// module has NO top-level side effects.
import type { RecordModel } from 'pocketbase';
import { writable } from 'svelte/store';
import { pb } from '../pb';
import { sessionScope } from './session';
import { httpStatus } from '../http-status';

export interface AuthState {
	nickname: string | null;
	isValid: boolean;
}

export const authState = writable<AuthState>({ nickname: null, isValid: false });

// null only when no auth record is held: an empty nickname (an OIDC provider
// that sent no name claim) is still a signed-in record and stays "".
function recordNickname(): string | null {
	const record = pb.authStore.record as { nickname?: string } | null;
	return record?.nickname ?? null;
}

/**
 * The signed-in account's id; null signed out. An expired session keeps its
 * record, so the id is still here.
 */
export function currentAccountId(): string | null {
	return pb.authStore.record?.id ?? null;
}

/** Publish the SDK auth store's current record and validity to `authState`. */
export function syncAuthState(): void {
	authState.set({ nickname: recordNickname(), isValid: pb.authStore.isValid });
}

/** Whether an auth-refresh error is the server's explicit 401. List rules turn
 *  an unaccepted token into a filtered 200, so only auth-refresh gives the real
 *  verdict. Shared by startup and the sync purge guard. */
export function isAuthRejected(error: unknown): boolean {
	return httpStatus(error) === 401;
}

/**
 * Mark the current auth state as expired, on a sync 401. The SDK's onChange
 * fires only on save/clear, so without this SyncBanner's 'expired' state
 * (§5.8) would need a reload.
 */
export function markAuthExpired(): void {
	authState.set({ nickname: recordNickname(), isValid: false });
}

/**
 * Refresh the session token (§5.6's sliding window), saving the result only
 * while the session that sent it is still current ([D-109], [D-156]). Not the
 * SDK's authRefresh(): that saves unconditionally, so a sign-out during the
 * request would be undone by its response. Rejects like authRefresh(); a
 * response for an ended session resolves without touching the store.
 */
export async function refreshSessionToken(): Promise<void> {
	const session = sessionScope();
	const res = await pb.send<{ token: string; record: RecordModel }>(
		'/api/collections/accounts/auth-refresh',
		{ method: 'POST' }
	);
	if (session.owned()) pb.authStore.save(res.token, res.record);
}
