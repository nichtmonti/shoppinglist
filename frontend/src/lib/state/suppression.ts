// Suggestion suppression (§6.11): account-bound, mirrored in `meta` for instant
// offline effect and written through PocketBase's own-row path, with
// unconfirmed changes kept in `suppressed_pending` ([D-137]).
import { db, getMeta, setMeta } from '#lib/db.js';
import { pb } from '#lib/pb.js';
import { normalizeName } from '#lib/normalize.js';
import { t } from '#lib/i18n/index.js';
import { showFailure } from '#lib/toasts.js';
import { sessionScope } from '#lib/auth/session.js';
import { httpStatus } from '#lib/http-status.js';
import { serialQueue } from '#lib/serial.js';
import { live } from './live';

const SUPPRESSED_KEY = 'suppressed_names';

/** The mirrored suppression list — normalized names (§6.11, [D-44]). */
export const suppressedNames = live<string[]>(loadSuppressed, [], `meta:${SUPPRESSED_KEY}`);

export async function loadSuppressed(): Promise<string[]> {
	return (await getMeta(SUPPRESSED_KEY)) ?? [];
}

/**
 * Changes the server has not confirmed yet: normalized name → latest intent
 * ([D-137]). The mirror is the last confirmed server copy with these applied,
 * so a change survives failed writes and boots until the server has or refuses
 * it.
 */
const SUPPRESSED_PENDING_KEY = 'suppressed_pending';
export type PendingSuppression = Record<string, 'add' | 'remove'>;

async function loadPending(): Promise<PendingSuppression> {
	return (await getMeta(SUPPRESSED_PENDING_KEY)) ?? {};
}

/** `base` with every pending intent applied, in `base`'s order then new names. */
function applyPending(base: string[], pending: PendingSuppression): string[] {
	const out = base.filter((n) => pending[n] !== 'remove');
	for (const [name, op] of Object.entries(pending)) {
		if (op === 'add' && !out.includes(name)) out.push(name);
	}
	return out;
}

function namesOf(record: unknown): string[] | null {
	const value = (record as { suppressed_names?: unknown } | null)?.suppressed_names;
	return Array.isArray(value) ? value.map(String) : null;
}

/**
 * Worth retrying: no connection, an expired token (re-auth triggers the next
 * flush), or the server unavailable. Anything else is a refusal for good.
 */
function isTransient(error: unknown): boolean {
	const status = httpStatus(error);
	if (status === undefined) return true;
	return status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
}

// Flushes and boot refreshes run one at a time, so two cannot interleave their
// read-merge-write of the same account record.
const serialize = serialQueue();

/** Record one intent locally (instant and offline), then try to deliver it. */
async function recordSuppression(key: string, op: 'add' | 'remove'): Promise<void> {
	const changed = await db.transaction('rw', db.meta, async () => {
		const current = await loadSuppressed();
		if (current.includes(key) === (op === 'add')) return false;
		await setMeta(SUPPRESSED_KEY, applyPending(current, { [key]: op }));
		await setMeta(SUPPRESSED_PENDING_KEY, { ...(await loadPending()), [key]: op });
		return true;
	});
	// Not awaited: the mirror has already taken effect.
	if (changed) void flushSuppressed();
}

/** "Nicht mehr vorschlagen" on any suggestion (§9). Names are normalized. */
export async function suppressName(name: string): Promise<void> {
	const key = normalizeName(name);
	if (!key) return;
	await recordSuppression(key, 'add');
}

/** Un-suppress, from the settings screen or by adding the name again (§6.11). */
export async function unsuppressName(name: string): Promise<void> {
	const key = normalizeName(name);
	if (!key) return;
	await recordSuppression(key, 'remove');
}

/**
 * Deliver the pending intents on the own-row path (§6.11). The intents are
 * applied to the account's current list, not this device's whole list, so
 * another device's change is not erased; the non-atomic read-then-write is the
 * window §6.11 accepts. A transient failure keeps the intents; a refusal drops
 * them, falls back to the server's copy and says so ([D-137]). A sign-out in
 * flight disowns the result ([D-109]). Never rejects.
 */
export function flushSuppressed(): Promise<void> {
	return serialize(async () => {
		const session = sessionScope();
		const accountId = pb.authStore.record?.id;
		if (!accountId) return;
		const sent = await loadPending();
		if (Object.keys(sent).length === 0) return;

		let server: string[] | null = null;
		let refused = false;
		try {
			const record = await pb.collection('accounts').getOne(accountId);
			const saved = await pb
				.collection('accounts')
				.update(accountId, { suppressed_names: applyPending(namesOf(record) ?? [], sent) });
			server = namesOf(saved);
		} catch (error) {
			if (isTransient(error)) return;
			refused = true;
			server = namesOf(pb.authStore.record);
		}

		// Checked inside the transaction: the wipe is a `meta` transaction too,
		// so this either runs before it or sees the ended session.
		const owned = await db.transaction('rw', db.meta, async () => {
			if (!session.owned()) return false;
			// Keep only intents recorded while this write was in flight.
			const now = await loadPending();
			const remaining: PendingSuppression = {};
			for (const [name, op] of Object.entries(now)) if (sent[name] !== op) remaining[name] = op;
			await setMeta(SUPPRESSED_PENDING_KEY, remaining);
			if (server) await setMeta(SUPPRESSED_KEY, applyPending(server, remaining));
			return true;
		});
		if (owned && refused) showFailure(t('settings_hidden_suggestions_save_failed'));
	}).catch((error: unknown) => console.error('suppression flush failed', error));
}

/**
 * At session start, mirror the account record's list with the pending intents
 * on top, then deliver them without making boot wait.
 */
export async function refreshSuppressedMirror(): Promise<void> {
	await serialize(async () => {
		const remote = namesOf(pb.authStore.record);
		if (!remote) return;
		// One transaction, so a change recorded meanwhile is not dropped.
		await db.transaction('rw', db.meta, async () => {
			await setMeta(SUPPRESSED_KEY, applyPending(remote, await loadPending()));
		});
	});
	void flushSuppressed();
}
