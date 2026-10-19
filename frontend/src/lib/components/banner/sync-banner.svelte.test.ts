// §12.1 sync-status chip — the four states, per-list pending scoping, ICU
// plurals, and the permanence of the chip itself (always present, constant box,
// state swapped in place so the app bar it sits in never reflows).
import { LocalizedError } from '#lib/localized-error.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { type Writable } from 'svelte/store';
import { db, type PendingOp } from '#lib/db.js';
import { resetDb } from '#lib/test-kit/db.js';

// #lib/auth reaches for IndexedDB and WebAuthn on import — mock the whole
// module, same pattern as auth-screen.svelte.test.ts.
vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock();
});

// #lib/state/online listens on window 'online'/'offline' and caches its last
// value across the store's start/stop cycle — real event dispatch would leak
// state across tests depending on subscribe/unsubscribe timing. Mock it so
// each test controls connectivity directly and deterministically.
vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	return { online: writable(true) };
});

// The re-auth failure path reports through the toaster; mock it so the
// assertion is "the failure was reported", not sonner's rendering (which
// toaster.svelte.test.ts already covers).
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock()
);

import {
	authState,
	fetchAuthMethods,
	isCeremonyDismissal,
	lastLoginMethod,
	login,
	oidcLogin,
	WrongAccountError
} from '#lib/auth/index.js';
import { pb } from '#lib/pb.js';
import { defaultAuthMethods } from '#lib/test-kit/auth-mock.js';
import { refreshAuthMethods } from '#lib/state/auth-methods.js';
import { showFailure } from '#lib/toasts.js';
import { online as onlineStore } from '#lib/state/online.js';
import SyncBanner from './SyncBanner.svelte';

// The real module types `online` as a plain Readable<boolean>; the mock above
// backs it with a writable so tests can drive connectivity directly.
const online = onlineStore as unknown as Writable<boolean>;

const LIST_A = 'list-a';
const LIST_B = 'list-b';

function makeOp(overrides: Partial<PendingOp> & { record_id: string; list_id: string }): PendingOp {
	const now = new Date().toISOString();
	return {
		op_id: `op-${overrides.record_id}`,
		collection: 'items',
		type: 'update',
		changed: {},
		base: {},
		queued_at: now,
		...overrides
	};
}

async function setSyncedAt(iso: string | null): Promise<void> {
	if (iso === null) {
		await db.meta.delete('last_synced_at');
	} else {
		await db.meta.put({ key: 'last_synced_at', value: iso });
	}
}

beforeEach(async () => {
	await resetDb();
	authState.set({ nickname: null, isValid: false });
	online.set(true);
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('SyncBanner', () => {
	// The green state carries no timestamp: "all synced" already means "nothing
	// outstanding, as of now", so how long ago the cycle ran is not actionable —
	// it only churns the text. Staleness is the message offline, not here.
	it('renders the synced state with no last-sync time, even when one exists', async () => {
		await setSyncedAt(new Date(Date.now() - 5 * 60_000).toISOString());
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() => {
			expect(screen.getByText('Alle Änderungen synchronisiert')).toBeDefined();
		});
		expect(document.querySelector('.when')).toBeNull();
	});

	// [D-296] Green only while true: tries that keep failing for 5 minutes
	// turn it into a grey clock that says since when.
	it('shows a grey clock once the server has not answered for 5 minutes', async () => {
		const since = new Date(Date.now() - 25 * 60_000).toISOString();
		await setSyncedAt(since);
		await db.meta.put({
			key: 'sync_health',
			value: {
				ok_at: since,
				started_at: new Date().toISOString(),
				failures: 4,
				reason: 'connection'
			}
		});
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() => {
			expect(screen.getByText('Keine Antwort vom Server · zuletzt vor 25 Minuten')).toBeDefined();
		});
		expect(screen.queryByText('Alle Änderungen synchronisiert')).toBeNull();
	});

	it('says "never synced" rather than an empty gap when meta.last_synced_at is unset', async () => {
		// Offline, since that is the state that still shows a timestamp at all.
		online.set(false);
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() => {
			expect(screen.getByText('zuletzt noch nie')).toBeDefined();
		});
	});

	it('renders the pending state, scoped to this list only', async () => {
		await db.pending_ops.put(makeOp({ record_id: 'a1', list_id: LIST_A }));
		await db.pending_ops.put(makeOp({ record_id: 'b1', list_id: LIST_B }));
		await db.pending_ops.put(makeOp({ record_id: 'b2', list_id: LIST_B }));
		render(SyncBanner, { listId: LIST_A });

		// If list B's ops leaked in, this would read "3 Änderungen …" instead.
		await waitFor(() => {
			expect(screen.getByText('1 Änderung noch nicht synchronisiert')).toBeDefined();
		});
	});

	it('uses distinct singular and plural forms for the pending count', async () => {
		await db.pending_ops.put(makeOp({ record_id: 'a1', list_id: LIST_A }));
		render(SyncBanner, { listId: LIST_A });
		await waitFor(() => {
			expect(screen.getByText('1 Änderung noch nicht synchronisiert')).toBeDefined();
		});

		await db.pending_ops.put(makeOp({ record_id: 'a2', list_id: LIST_A }));
		await db.pending_ops.put(makeOp({ record_id: 'a3', list_id: LIST_A }));
		await waitFor(() => {
			expect(screen.getByText('3 Änderungen noch nicht synchronisiert')).toBeDefined();
		});
	});

	// [D-102]: the count IS the glyph. title= never renders on touch and the
	// sentence is .sr-only, so before this the pending number was invisible to
	// a sighted phone user — in an offline-first app. A corner badge was
	// rejected: the 26px slot is reserved so state changes cannot reflow the
	// app bar, and a badge outside it breaks that.
	it('shows the pending count as the chip glyph, visible without hover', async () => {
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => screen.getByText('Alle Änderungen synchronisiert'));

		await db.pending_ops.put(makeOp({ record_id: 'a1', list_id: LIST_A }));
		await waitFor(() => {
			expect(screen.getByText('1')).toBeDefined();
		});
		// The number replaces the cloud; it does not join it.
		expect(container.querySelector('.banner svg')).toBeNull();

		await db.pending_ops.put(makeOp({ record_id: 'a2', list_id: LIST_A }));
		await waitFor(() => {
			expect(screen.getByText('2')).toBeDefined();
		});
	});

	it('shows the pending count on the offline chip too, next to the last-sync time', async () => {
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => screen.getByText('Alle Änderungen synchronisiert'));

		await db.pending_ops.put(makeOp({ record_id: 'a1', list_id: LIST_A }));
		online.set(false);
		await waitFor(() => {
			expect(screen.getByText('1')).toBeDefined();
		});
		expect(container.querySelector('.banner')?.classList.contains('offline')).toBe(true);
	});

	it('renders the offline state with the scoped pending count and last-sync time', async () => {
		await setSyncedAt(new Date(Date.now() - 5 * 60_000).toISOString());
		await db.pending_ops.put(makeOp({ record_id: 'a1', list_id: LIST_A }));
		online.set(false);
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() => {
			expect(screen.getByText('Offline · 1 nicht synchronisiert')).toBeDefined();
		});
		expect(document.querySelector('.when')?.textContent?.startsWith('zuletzt')).toBe(true);
	});

	it('renders bare "Offline" when nothing is pending', async () => {
		online.set(false);
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() => {
			expect(screen.getByText('Offline')).toBeDefined();
		});
	});

	it('routes an expired session into the one-tap re-auth button, not silently', async () => {
		authState.set({ nickname: 'Anna', isValid: false });
		render(SyncBanner, { listId: LIST_A });

		const button = await screen.findByRole('button', {
			name: 'Sitzung abgelaufen. Melde dich erneut an, um zu synchronisieren.'
		});
		// [D-102]: expired shares no glyph with offline (a key, not cloud-off)
		// and no tint with pending (filled destructive, not amber) — the one
		// actionable state is separated by shape and fill, not hue alone.
		expect(button.querySelector('svg')?.classList.contains('lucide-key-round')).toBe(true);
		expect(button.className).toContain('bg-danger');
		expect(vi.mocked(login)).not.toHaveBeenCalled();
		await fireEvent.click(button);
		expect(vi.mocked(login)).toHaveBeenCalledTimes(1);
	});

	it('offline wins over an expired token — nothing to tap until connectivity returns', async () => {
		authState.set({ nickname: 'Anna', isValid: false });
		online.set(false);
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() => {
			expect(screen.getByText('Offline')).toBeDefined();
		});
		expect(screen.queryByRole('button')).toBeNull();
	});

	// The chip is permanent: no idle timer, no auto-hide, no reveal-on-activity.
	// At 26px there is nothing to get out of the way of, and a
	// cloud that is always there means "synced" reads positively instead of
	// having to be inferred from the absence of a warning.
	it('stays visible in the settled state — no idle timer collapses it', async () => {
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => {
			expect(screen.getByText('Alle Änderungen synchronisiert')).toBeDefined();
		});
		const banner = container.querySelector('.banner')!;

		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(container.querySelector('.banner')).toBe(banner);
		expect(banner.classList.contains('is-hidden')).toBe(false);
		expect(screen.getByText('Alle Änderungen synchronisiert')).toBeDefined();
	});

	// The whole point of the chip form: its box is constant, so a state change
	// cannot reflow the app bar it sits in. Only the tint class changes.
	it('swaps state in place without adding or removing the chip', async () => {
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => screen.getByText('Alle Änderungen synchronisiert'));
		const banner = container.querySelector('.banner')!;
		expect(banner.classList.contains('synced')).toBe(true);

		online.set(false);
		await tick();
		await waitFor(() => screen.getByText('Offline'));
		// Same node, still exactly one chip — not torn down and rebuilt.
		expect(container.querySelector('.banner')).toBe(banner);
		expect(container.querySelectorAll('.banner')).toHaveLength(1);
		expect(banner.classList.contains('offline')).toBe(true);

		online.set(true);
		await tick();
		await waitFor(() => screen.getByText('Alle Änderungen synchronisiert'));
		expect(container.querySelector('.banner')).toBe(banner);
		expect(banner.classList.contains('synced')).toBe(true);
	});

	// The role="status" live region must survive the expired transition. If it
	// lived on the state div (as in earlier revisions), tearing that div down for
	// the re-auth button would kill the announcement of the ONE state that needs
	// action — the session just died silently as far as a screen reader is
	// concerned. The region sits on the permanent wrapper instead, and the
	// button swaps inside it.
	it('keeps one live region across the expired transition — the announcement never dies', async () => {
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => screen.getByText('Alle Änderungen synchronisiert'));
		const region = container.querySelector('[role="status"]')!;
		expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);

		authState.set({ nickname: 'Anna', isValid: false });
		await tick();
		await waitFor(() =>
			screen.getByRole('button', {
				name: 'Sitzung abgelaufen. Melde dich erneut an, um zu synchronisieren.'
			})
		);
		// Same live region, still exactly one — the button swapped inside it.
		expect(container.querySelector('[role="status"]')).toBe(region);
		expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);

		authState.set({ nickname: 'Anna', isValid: true });
		await tick();
		await waitFor(() => screen.getByText('Alle Änderungen synchronisiert'));
		expect(container.querySelector('[role="status"]')).toBe(region);
		expect(container.querySelectorAll('.banner')).toHaveLength(1);
	});

	it('stays visible while there are pending ops', async () => {
		await db.pending_ops.put(makeOp({ record_id: 'a1', list_id: LIST_A }));
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => screen.getByText('1 Änderung noch nicht synchronisiert'));

		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(container.querySelector('.banner')).not.toBeNull();
		expect(screen.getByText('1 Änderung noch nicht synchronisiert')).toBeDefined();
	});

	it('stays visible while offline', async () => {
		online.set(false);
		const { container } = render(SyncBanner, { listId: LIST_A });
		await waitFor(() => screen.getByText('Offline'));

		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(container.querySelector('.banner')).not.toBeNull();
		expect(screen.getByText('Offline')).toBeDefined();
	});
});

// [D-130]: the chip is the ONLY control that clears an expired session, so a
// tap of it that fails must say so — `void login()` rejected into nothing, and
// a red chip that stays red is indistinguishable from a dead button. The chip
// is also mounted outside a list now, which is what the scope test covers.
describe('SyncBanner — the re-auth tap reports what happened ([D-130])', () => {
	async function expiredChip(): Promise<HTMLElement> {
		authState.set({ nickname: 'Anna', isValid: false });
		render(SyncBanner, { listId: LIST_A });
		return screen.findByRole('button', {
			name: 'Sitzung abgelaufen. Melde dich erneut an, um zu synchronisieren.'
		});
	}

	it('toasts the ceremony error when re-auth fails', async () => {
		vi.mocked(login).mockRejectedValueOnce(new LocalizedError('Passkey nicht erkannt'));
		const button = await expiredChip();

		await fireEvent.click(button);

		await waitFor(() =>
			expect(vi.mocked(showFailure)).toHaveBeenCalledWith('Passkey nicht erkannt')
		);
		// The session did not come back, so the chip stays the actionable one.
		expect(button.isConnected).toBe(true);
	});

	it('stays silent when the user dismisses the prompt — that is an answer, not an error', async () => {
		const dismissal = Object.assign(new Error('abgebrochen'), { name: 'NotAllowedError' });
		vi.mocked(login).mockRejectedValueOnce(dismissal);
		vi.mocked(isCeremonyDismissal).mockReturnValueOnce(true);
		const button = await expiredChip();

		await fireEvent.click(button);

		await waitFor(() => expect(vi.mocked(login)).toHaveBeenCalledTimes(1));
		expect(vi.mocked(showFailure)).not.toHaveBeenCalled();
	});

	it('runs one ceremony at a time — a double tap cannot start a second', async () => {
		let release: (() => void) | undefined;
		vi.mocked(login).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const button = await expiredChip();

		await fireEvent.click(button);
		await fireEvent.click(button);
		expect(vi.mocked(login)).toHaveBeenCalledTimes(1);

		release?.();
		await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
	});
});

// [D-130]: off a list, filtering the outbox on list id '' counted the ops of a list whose id
// is the empty string — always 0 — so the chip on the home would have read "all
// synced" over an undrained queue. Without a listId it reports the whole outbox.
describe('SyncBanner — what the count means off a list ([D-130])', () => {
	it("counts every list's pending ops when no list is on screen", async () => {
		await db.pending_ops.bulkPut([
			makeOp({ record_id: 'a1', list_id: LIST_A }),
			makeOp({ record_id: 'b1', list_id: LIST_B }),
			makeOp({ record_id: 'b2', list_id: LIST_B })
		]);
		authState.set({ nickname: 'Anna', isValid: true });
		render(SyncBanner);

		await waitFor(() =>
			expect(screen.getByText('3 Änderungen noch nicht synchronisiert')).toBeDefined()
		);
	});

	it('still scopes to the list when there is one', async () => {
		await db.pending_ops.bulkPut([
			makeOp({ record_id: 'a1', list_id: LIST_A }),
			makeOp({ record_id: 'b1', list_id: LIST_B })
		]);
		authState.set({ nickname: 'Anna', isValid: true });
		render(SyncBanner, { listId: LIST_A });

		await waitFor(() =>
			expect(screen.getByText('1 Änderung noch nicht synchronisiert')).toBeDefined()
		);
	});
});

// [D-76]: the chip re-authenticates with a login the account can use. An
// expired session cannot ask the server which logins the account has, so it
// follows how this device last signed in, while the instance still has it on.
describe('SyncBanner — re-auth follows the instance and the last login ([D-76])', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// An expired session keeps its record: the account re-auth must land in.
		pb.authStore.save('expired', { id: 'acct-1' } as never);
	});

	afterEach(() => {
		pb.authStore.clear();
	});

	async function expiredChip(): Promise<HTMLElement> {
		authState.set({ nickname: 'Anna', isValid: false });
		render(SyncBanner, { listId: LIST_A });
		return screen.findByRole('button', {
			name: 'Sitzung abgelaufen. Melde dich erneut an, um zu synchronisieren.'
		});
	}

	it('signs back in with OIDC after an OIDC sign-in', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		await refreshAuthMethods();
		vi.mocked(lastLoginMethod).mockReturnValue('oidc');

		await fireEvent.click(await expiredChip());

		await waitFor(() =>
			expect(vi.mocked(oidcLogin)).toHaveBeenCalledWith('oidc', { expectAccount: 'acct-1' })
		);
		expect(vi.mocked(login)).not.toHaveBeenCalled();
	});

	it('uses OIDC on an instance without passkeys, whatever the device remembers', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({
				passkeys: { enabled: false, signup: false },
				oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' }
			})
		);
		await refreshAuthMethods();
		vi.mocked(lastLoginMethod).mockReturnValue('passkey');

		await fireEvent.click(await expiredChip());

		await waitFor(() =>
			expect(vi.mocked(oidcLogin)).toHaveBeenCalledWith('oidc', { expectAccount: 'acct-1' })
		);
		expect(vi.mocked(login)).not.toHaveBeenCalled();
	});

	it('stays with passkeys when the remembered OIDC login is off now', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		await refreshAuthMethods();
		vi.mocked(lastLoginMethod).mockReturnValue('oidc');
		vi.mocked(login).mockResolvedValueOnce(undefined);

		await fireEvent.click(await expiredChip());

		await waitFor(() => expect(vi.mocked(login)).toHaveBeenCalledTimes(1));
		expect(vi.mocked(oidcLogin)).not.toHaveBeenCalled();
	});

	// [D-76]: re-auth keeps the account this device holds.
	it('asks the passkey re-auth for the account this device holds', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		await refreshAuthMethods();
		vi.mocked(lastLoginMethod).mockReturnValue('passkey');
		vi.mocked(login).mockResolvedValueOnce(undefined);

		await fireEvent.click(await expiredChip());

		await waitFor(() => expect(vi.mocked(login)).toHaveBeenCalledWith({ expectAccount: 'acct-1' }));
	});

	it('says the OIDC login is no longer connected when the sign-in landed in a new account', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		await refreshAuthMethods();
		vi.mocked(lastLoginMethod).mockReturnValue('oidc');
		vi.mocked(oidcLogin).mockRejectedValueOnce(new WrongAccountError(true));

		await fireEvent.click(await expiredChip());

		await waitFor(() =>
			expect(vi.mocked(showFailure)).toHaveBeenCalledWith(
				'Deine Keycloak-Anmeldung ist nicht mehr mit diesem Konto verbunden. Melde dich mit deinem Passkey an.'
			)
		);
	});

	it('says it was a different account when the sign-in landed in an existing one', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		await refreshAuthMethods();
		vi.mocked(lastLoginMethod).mockReturnValue('passkey');
		vi.mocked(login).mockRejectedValueOnce(new WrongAccountError(false));

		await fireEvent.click(await expiredChip());

		await waitFor(() =>
			expect(vi.mocked(showFailure)).toHaveBeenCalledWith(
				'Das ist ein anderes Konto. Melde dich bei dem Konto an, das dieses Gerät benutzt hat, oder melde dich zuerst ab.'
			)
		);
	});
});
