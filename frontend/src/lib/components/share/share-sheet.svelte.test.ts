// §7.1 Share & members sheet. Follows the harness pattern documented in
// src/lib/components/auth/auth-screen.svelte.test.ts: mock the modules that
// reach outside happy-dom (#lib/pb, #lib/actions/invites, #lib/sync/roster), seed
// Dexie (fake-indexeddb) BEFORE render(), then await the liveQuery-backed
// roster/membership stores via waitFor().
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/pb.js', async () => (await import('#lib/test-kit/pb-mock.js')).pbModuleMock());

vi.mock('#lib/sync/roster.js', () => ({ refreshRoster: vi.fn().mockResolvedValue([]) }));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({ showToast })
);

// The sheet reaches invites through three calls: currentInvite (what to show
// on open), rotateInvite ("Link zurücksetzen", "Link erstellen") and
// revokeInvite ("Link zurückziehen"). Which invite and token those pick — none
// when the list has no link, the cached token, none for another device's — is
// asserted in src/lib/actions/invites.test.ts; here they are the sheet's inputs.
vi.mock('#lib/actions/invites.js', async () => ({
	...(await vi.importActual<typeof import('#lib/actions/invites.js')>('#lib/actions/invites.js')),
	currentInvite: vi.fn(),
	rotateInvite: vi.fn(),
	revokeInvite: vi.fn(),
	inviteUrl: (token: string) => `https://example.test/join#${token}`,
	tokenFromInput: (s: string) => s
}));

import { db } from '#lib/db.js';
import { resetDb, makeMembership } from '#lib/test-kit/db.js';
import { currentInvite, revokeInvite, rotateInvite, type Invite } from '#lib/actions/invites.js';
import { refreshRoster } from '#lib/sync/roster.js';
import ShareSheet from './ShareSheet.svelte';

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
});

function invite(overrides: Partial<Invite> = {}): Invite {
	return {
		id: 'inv-1',
		list: 'list-1',
		expires_at: '2026-08-25T00:00:00.000Z',
		revoked: false,
		...overrides
	};
}

describe('ShareSheet', () => {
	it('renders the roster with a "you" badge, and shows the invite link and QR', async () => {
		await db.memberships.put(makeMembership({ list: 'list-1', account: 'account-1' }));
		await db.roster.bulkPut([
			{
				id: 'list-1_account-1',
				list: 'list-1',
				account: 'account-1',
				nickname: 'Anna',
				joined: '2026-01-01T00:00:00.000Z'
			},
			{
				id: 'list-1_account-2',
				list: 'list-1',
				account: 'account-2',
				nickname: 'Ben',
				joined: '2026-01-05T00:00:00.000Z'
			}
		]);
		vi.mocked(currentInvite).mockResolvedValue(invite({ token: 'tok-abc' }));

		render(ShareSheet, { open: true, listId: 'list-1', onclose: vi.fn() });

		await waitFor(() => {
			expect(screen.getByText('Anna')).toBeDefined();
			expect(screen.getByText('Ben')).toBeDefined();
			expect(screen.getByText('du')).toBeDefined();
		});

		await waitFor(() => {
			expect(screen.getByText('https://example.test/join#tok-abc')).toBeDefined();
		});

		expect(vi.mocked(currentInvite)).toHaveBeenCalledWith('list-1');

		// The Link/QR switch is the app's segmented band (role radio, like the
		// list's view toggle), and it shows which side is chosen. The QR side
		// renders only once chosen.
		const linkChoice = screen.getByRole('radio', { name: 'Einladungslink' });
		const qrChoice = screen.getByRole('radio', { name: 'QR' });
		expect(linkChoice.getAttribute('aria-checked')).toBe('true');
		expect(qrChoice.getAttribute('aria-checked')).toBe('false');
		expect(screen.queryByText('Scannen zum Beitreten')).toBeNull();
		await fireEvent.click(qrChoice);
		await waitFor(() => expect(qrChoice.getAttribute('aria-checked')).toBe('true'));
		expect(linkChoice.getAttribute('aria-checked')).toBe('false');
		expect(screen.getByText('Scannen zum Beitreten')).toBeDefined();
		expect(screen.queryByText('https://example.test/join#tok-abc')).toBeNull();
	});

	it('lists the members in the order they joined, not by account id', async () => {
		await db.memberships.put(makeMembership({ list: 'list-1', account: 'b-first' }));
		await db.roster.bulkPut([
			{
				id: 'list-1_a-later',
				list: 'list-1',
				account: 'a-later',
				nickname: 'Ben',
				joined: '2026-01-05T00:00:00.000Z'
			},
			{
				id: 'list-1_b-first',
				list: 'list-1',
				account: 'b-first',
				nickname: 'Anna',
				joined: '2026-01-01T00:00:00.000Z'
			}
		]);
		vi.mocked(currentInvite).mockResolvedValue(invite({ token: 'tok-abc' }));

		render(ShareSheet, { open: true, listId: 'list-1', onclose: vi.fn() });

		await waitFor(() => {
			const rows = [...document.querySelectorAll('.roster [id$="-label"]')];
			expect(rows.map((r) => r.textContent?.trim())).toEqual(['Anna', 'Ben']);
		});
	});

	// One timer per confirmation: an earlier copy's must not end a later one's.
	it('shows "Link kopiert" for its full time after a second copy', async () => {
		vi.mocked(currentInvite).mockResolvedValue(invite({ token: 'tok-abc' }));
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		render(ShareSheet, { open: true, listId: 'list-1', onclose: vi.fn() });
		const copy = await screen.findByRole('button', { name: 'Kopieren' });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			await fireEvent.click(copy);
			await vi.advanceTimersByTimeAsync(1500);
			expect(copy.textContent?.trim()).toBe('Link kopiert');
			await fireEvent.click(copy);
			await vi.advanceTimersByTimeAsync(1000);
			expect(copy.textContent?.trim()).toBe('Link kopiert');
			await vi.advanceTimersByTimeAsync(1000);
			expect(copy.textContent?.trim()).toBe('Kopieren');
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	// [D-236]: the person sharing holds the sheet open while the other one
	// joins, so it keeps re-reading the roster, and reads it once more on close
	// for the list header's member line.
	it('refreshes the roster on open, every 5s while open, and on close', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			await db.memberships.put(makeMembership({ list: 'list-1', account: 'account-1' }));
			vi.mocked(currentInvite).mockResolvedValue(invite({ token: 'tok-abc' }));
			const sheet = render(ShareSheet, { open: true, listId: 'list-1', onclose: vi.fn() });
			const calls = () => vi.mocked(refreshRoster).mock.calls.length;
			expect(calls()).toBe(1);

			vi.advanceTimersByTime(5000);
			expect(calls()).toBe(2);
			vi.advanceTimersByTime(5000);
			expect(calls()).toBe(3);

			await sheet.rerender({ open: false, listId: 'list-1', onclose: vi.fn() });
			expect(calls()).toBe(4);
			vi.advanceTimersByTime(15_000);
			expect(calls()).toBe(4);
			expect(vi.mocked(refreshRoster).mock.calls.every(([list]) => list === 'list-1')).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	// An account may have no nickname (an OIDC provider that sent no name).
	it('shows a placeholder for a member without a nickname', async () => {
		await db.memberships.put(makeMembership({ list: 'list-1', account: 'account-1' }));
		await db.roster.put({
			id: 'list-1_account-2',
			list: 'list-1',
			account: 'account-2',
			nickname: '',
			joined: '2026-01-05T00:00:00.000Z'
		});
		vi.mocked(currentInvite).mockResolvedValue(invite({ token: 'tok-abc' }));

		render(ShareSheet, { open: true, listId: 'list-1', onclose: vi.fn() });

		// The sheet renders into a portal, outside the render container.
		await waitFor(() =>
			expect(document.querySelector('.roster > *')?.textContent).toContain('Mitglied')
		);
	});

	it('"Link zurücksetzen" mints a new invite', async () => {
		await db.memberships.put(makeMembership({ list: 'list-2', account: 'account-1' }));
		vi.mocked(currentInvite).mockResolvedValue(
			invite({ id: 'inv-1', list: 'list-2', token: 'tok-old' })
		);
		vi.mocked(rotateInvite).mockResolvedValue(
			invite({
				id: 'inv-2',
				list: 'list-2',
				token: 'tok-new',
				expires_at: '2026-09-01T00:00:00.000Z'
			})
		);

		render(ShareSheet, { open: true, listId: 'list-2', onclose: vi.fn() });

		await waitFor(() => {
			expect(screen.getByText('https://example.test/join#tok-old')).toBeDefined();
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Link zurücksetzen' }));
		// [D-293] It retires the link already sent, so it is confirmed first.
		expect(vi.mocked(rotateInvite)).not.toHaveBeenCalled();
		const confirm = await screen.findByRole('alertdialog');
		expect(confirm.textContent).toContain('funktioniert dann nicht mehr');
		await fireEvent.click(within(confirm).getByRole('button', { name: 'Zurücksetzen' }));

		await waitFor(() => {
			expect(screen.getByText('https://example.test/join#tok-new')).toBeDefined();
		});
		// Reset must read as a *done* event, not a silent token swap: a toast,
		// as every done-message, says the old link is gone.
		expect(showToast).toHaveBeenCalledWith(
			'Neuer Link erstellt. Der alte funktioniert nicht mehr.'
		);
		expect(vi.mocked(rotateInvite)).toHaveBeenCalledWith('list-2');
		// The old link must be gone from the screen too — resetting is the way a
		// user kills a link they already sent someone, so continuing to offer it
		// for copying would defeat the whole action.
		expect(screen.queryByText('https://example.test/join#tok-old')).toBeNull();
	});

	it('"Link zurückziehen" leaves no link, and "Link erstellen" makes one ([D-310])', async () => {
		await db.memberships.put(makeMembership({ list: 'list-2', account: 'account-1' }));
		vi.mocked(currentInvite).mockResolvedValue(
			invite({ id: 'inv-1', list: 'list-2', token: 'tok-old' })
		);
		vi.mocked(revokeInvite).mockResolvedValue();
		vi.mocked(rotateInvite).mockResolvedValue(
			invite({ id: 'inv-2', list: 'list-2', token: 'tok-new' })
		);

		render(ShareSheet, { open: true, listId: 'list-2', onclose: vi.fn() });
		await screen.findByText('https://example.test/join#tok-old');

		// Like the reset it retires the link already sent, so it is confirmed.
		await fireEvent.click(screen.getByRole('button', { name: 'Link zurückziehen' }));
		expect(vi.mocked(revokeInvite)).not.toHaveBeenCalled();
		const confirm = await screen.findByRole('alertdialog');
		expect(confirm.textContent).toContain('funktioniert dann nicht mehr');
		await fireEvent.click(within(confirm).getByRole('button', { name: 'Zurückziehen' }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				'Link zurückgezogen. Niemand kann mehr damit beitreten.'
			)
		);
		expect(vi.mocked(revokeInvite)).toHaveBeenCalledWith('list-2');
		expect(screen.queryByText('https://example.test/join#tok-old')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Link zurücksetzen' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Link erstellen' }));
		expect(await screen.findByText('https://example.test/join#tok-new')).toBeDefined();
		expect(vi.mocked(rotateInvite)).toHaveBeenCalledWith('list-2');
		expect(screen.queryByText(/Link zurückgezogen/)).toBeNull();
	});

	// [D-330] Opening the sheet never mints: a revoked link stays revoked
	// until a member creates one, here or anywhere else.
	it('offers "Link erstellen" on reopening after a revoke, and mints nothing', async () => {
		await db.memberships.put(makeMembership({ list: 'list-2', account: 'account-1' }));
		vi.mocked(currentInvite).mockResolvedValue(
			invite({ id: 'inv-1', list: 'list-2', token: 'tok-old' })
		);
		vi.mocked(revokeInvite).mockResolvedValue();

		const { rerender } = render(ShareSheet, { open: true, listId: 'list-2', onclose: vi.fn() });
		await screen.findByText('https://example.test/join#tok-old');
		await fireEvent.click(screen.getByRole('button', { name: 'Link zurückziehen' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Zurückziehen' }));
		await waitFor(() => expect(showToast).toHaveBeenCalled());

		vi.mocked(currentInvite).mockResolvedValue(null);
		await rerender({ open: false, listId: 'list-2', onclose: vi.fn() });
		await rerender({ open: true, listId: 'list-2', onclose: vi.fn() });

		expect(await screen.findByText('Diese Liste hat gerade keinen Einladungslink.')).toBeDefined();
		expect(screen.getByRole('button', { name: 'Link erstellen' })).toBeDefined();
		expect(screen.queryByText(/Link zurückgezogen/)).toBeNull();
		expect(screen.queryByText('https://example.test/join#tok-old')).toBeNull();
		expect(vi.mocked(rotateInvite)).not.toHaveBeenCalled();
	});

	it('keeps the link and the revoke when revoking fails, since revoking twice is harmless', async () => {
		await db.memberships.put(makeMembership({ list: 'list-2', account: 'account-1' }));
		vi.mocked(currentInvite).mockResolvedValue(
			invite({ id: 'inv-1', list: 'list-2', token: 'tok-old' })
		);
		vi.mocked(revokeInvite).mockRejectedValue(new Error('Serverfehler'));

		render(ShareSheet, { open: true, listId: 'list-2', onclose: vi.fn() });
		await screen.findByText('https://example.test/join#tok-old');
		await fireEvent.click(screen.getByRole('button', { name: 'Link zurückziehen' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Zurückziehen' }));

		// The confirmation stays open and says it in place, as every confirm does.
		const dialog = await screen.findByRole('alertdialog');
		expect((await within(dialog).findByRole('alert')).textContent).toContain(
			'Etwas ist schiefgelaufen.'
		);
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
		expect(await screen.findByRole('button', { name: 'Link zurückziehen' })).toBeDefined();
	});

	it('reports the error, drops the link, and still offers the retry when a reset fails', async () => {
		await db.memberships.put(makeMembership({ list: 'list-2', account: 'account-1' }));
		vi.mocked(currentInvite).mockResolvedValue(
			invite({ id: 'inv-1', list: 'list-2', token: 'tok-old' })
		);
		vi.mocked(rotateInvite).mockRejectedValue(new Error('Serverfehler'));

		render(ShareSheet, { open: true, listId: 'list-2', onclose: vi.fn() });

		await waitFor(() => {
			expect(screen.getByText('https://example.test/join#tok-old')).toBeDefined();
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Link zurücksetzen' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Zurücksetzen' }));

		const dialog = await screen.findByRole('alertdialog');
		expect((await within(dialog).findByRole('alert')).textContent).toContain(
			'Etwas ist schiefgelaufen.'
		);
		// A failed rotation may still have committed server-side, so the old link
		// may already be dead — it must not stay on screen as if the reset hadn't happened.
		expect(screen.queryByText('https://example.test/join#tok-old')).toBeNull();
		// …but the retry is right there, the confirmation's own button — and it
		// mints for real on the second attempt.
		vi.mocked(rotateInvite).mockResolvedValue(
			invite({ id: 'inv-2', list: 'list-2', token: 'tok-new' })
		);
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Zurücksetzen' }));

		await waitFor(() => {
			expect(screen.getByText('https://example.test/join#tok-new')).toBeDefined();
		});
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('offers reset (no copyable link) for a link minted before the server kept its token', async () => {
		await db.memberships.put(makeMembership({ list: 'list-3', account: 'account-1' }));
		// No `token` field: this device never minted it and has no cached copy.
		vi.mocked(currentInvite).mockResolvedValue(invite({ id: 'inv-9', list: 'list-3' }));

		render(ShareSheet, { open: true, listId: 'list-3', onclose: vi.fn() });

		await waitFor(() => {
			expect(
				screen.getByText(
					'Dieser Link stammt aus einer älteren Version der App und lässt sich hier nicht anzeigen. Ein neuer Link ersetzt ihn für alle.'
				)
			).toBeDefined();
		});
		expect(screen.getByRole('button', { name: 'Link zurücksetzen' })).toBeDefined();
	});

	// [D-293] A load that failed changed nothing: its retry loads again, and
	// the reset, which would retire a link already sent, is not offered for it.
	it('offers to load again, not to reset, when the link cannot be loaded', async () => {
		await db.memberships.put(makeMembership({ list: 'list-2', account: 'account-1' }));
		vi.mocked(currentInvite)
			.mockRejectedValueOnce(Object.assign(new Error('Something went wrong.'), { status: 0 }))
			.mockResolvedValueOnce(invite({ id: 'inv-1', list: 'list-2', token: 'tok-old' }));

		render(ShareSheet, { open: true, listId: 'list-2', onclose: vi.fn() });

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Keine Verbindung zum Server');
		expect(screen.queryByRole('button', { name: 'Link zurücksetzen' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

		await waitFor(() => {
			expect(screen.getByText('https://example.test/join#tok-old')).toBeDefined();
		});
		expect(vi.mocked(rotateInvite)).not.toHaveBeenCalled();
	});

	// The home's sheet is one instance re-pointed at each list: the previous
	// list's link must neither linger nor come back from a late response.
	it("never shows the previous list's link after switching lists", async () => {
		await db.memberships.bulkPut([
			makeMembership({ list: 'list-1', account: 'account-1' }),
			makeMembership({ list: 'list-2', account: 'account-1' })
		]);
		vi.mocked(currentInvite).mockResolvedValueOnce(invite({ list: 'list-1', token: 'tok-one' }));

		const { rerender } = render(ShareSheet, { open: true, listId: 'list-1', onclose: vi.fn() });
		await waitFor(() =>
			expect(screen.getByText('https://example.test/join#tok-one')).toBeDefined()
		);

		let answerTwo!: (inv: Invite) => void;
		vi.mocked(currentInvite).mockReturnValueOnce(new Promise((r) => (answerTwo = r)));
		await rerender({ open: true, listId: 'list-2', onclose: vi.fn() });
		expect(screen.queryByText('https://example.test/join#tok-one')).toBeNull();

		// A late answer for list-1 must not overwrite list-2's.
		let answerOneAgain!: (inv: Invite) => void;
		vi.mocked(currentInvite).mockReturnValueOnce(new Promise((r) => (answerOneAgain = r)));
		await rerender({ open: true, listId: 'list-1', onclose: vi.fn() });
		vi.mocked(currentInvite).mockResolvedValueOnce(
			invite({ id: 'inv-2', list: 'list-2', token: 'tok-two' })
		);
		await rerender({ open: true, listId: 'list-2', onclose: vi.fn() });
		await waitFor(() =>
			expect(screen.getByText('https://example.test/join#tok-two')).toBeDefined()
		);
		answerOneAgain(invite({ list: 'list-1', token: 'tok-one' }));
		answerTwo(invite({ id: 'inv-2b', list: 'list-2', token: 'tok-stale' }));
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByText('https://example.test/join#tok-two')).toBeDefined();
	});
});
