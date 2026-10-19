// SignOutGroup — the [D-55] per-device sign-out and the §5.6 log out
// everywhere. Follows the harness pattern documented in
// auth-screen.svelte.test.ts: mock #lib/pb (no PocketBase runs here) and
// #lib/auth (logout).
import { t } from '#lib/i18n/index.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pbSend } = vi.hoisted(() => ({
	pbSend: vi.fn().mockResolvedValue({ ok: true })
}));

vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({ send: pbSend })
);

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock({}, { isValid: true });
});

import { logout } from '#lib/auth/index.js';
import { outbox } from '#lib/state/data.js';
import { makeItem, putSynced, queueOp, resetDb, untilLoaded } from '#lib/test-kit/db.js';
import SignOutGroup from './SignOutGroup.svelte';

beforeEach(async () => {
	vi.clearAllMocks();
	pbSend.mockResolvedValue({ ok: true });
	await resetDb();
});

// [D-55]: per-device sign-out. Distinct from
// "Überall abmelden" (§5.6 token rotation) in exactly the two ways pinned below: it calls #lib/auth's local
// logout() directly — no confirm sheet, no server round trip — so it also
// works offline. The AuthScreen flip itself is the root layout's reaction to
// the authState store logout() writes; a component harness cannot observe
// that, so the wiring contract here is "logout was called".
describe('per-device sign-out ([D-55])', () => {
	it('renders the sign-out button with its device-scoped label', () => {
		render(SignOutGroup);

		expect(screen.getByRole('button', { name: 'Auf diesem Gerät abmelden' })).toBeDefined();
	});

	it('signs out this device on a single tap, without the everywhere rotation', async () => {
		render(SignOutGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Auf diesem Gerät abmelden' }));

		// Local-only ([D-55]): one tap, no in-UI confirm step (handing the
		// device on is not a dangerous operation) — straight to logout().
		expect(vi.mocked(logout)).toHaveBeenCalledTimes(1);
		// And nothing is revoked server-side: the everywhere flow is the only
		// sign-out path that touches the rotation route.
		expect(pbSend).not.toHaveBeenCalled();
	});
});

// Sign-out wipes the outbox with the rest of the account's data (§5.6), so
// edits this device has not sent yet would be lost without a word.
describe('per-device sign-out with unsynced changes', () => {
	it('warns before discarding them, and signs out only when confirmed', async () => {
		await putSynced([makeItem({ id: 'item-1', list: 'list-1', name: 'Milch' })]);
		await queueOp({
			op_id: 'op-1',
			collection: 'items',
			record_id: 'item-1',
			list_id: 'list-1',
			type: 'update',
			changed: { quantity: '2' },
			base: { quantity: '' },
			queued_at: new Date().toISOString()
		});
		render(SignOutGroup);
		await untilLoaded(outbox(''));

		await fireEvent.click(screen.getByRole('button', { name: 'Auf diesem Gerät abmelden' }));

		const dialog = await screen.findByRole('alertdialog');
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Trotzdem abmelden' }));
		expect(vi.mocked(logout)).toHaveBeenCalledTimes(1);
	});
});

describe('log out everywhere (§5.6)', () => {
	it('rotates the token key via its route once confirmed, then ends the local session', async () => {
		render(SignOutGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Überall abmelden' }));
		// Confirmed first ([D-214]): one tap used to sign out every device.
		expect(pbSend).not.toHaveBeenCalled();
		await fireEvent.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', {
				name: 'Überall abmelden'
			})
		);

		await waitFor(() =>
			expect(pbSend).toHaveBeenCalledWith('/api/account/rotate-token-key', { method: 'POST' })
		);
		await waitFor(() => expect(vi.mocked(logout)).toHaveBeenCalled());
	});

	it('keeps the session and shows the error when the rotation fails', async () => {
		pbSend.mockRejectedValueOnce(new Error('Netzwerkfehler'));

		render(SignOutGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Überall abmelden' }));
		await fireEvent.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', {
				name: 'Überall abmelden'
			})
		);

		// In the dialog the user is still looking at.
		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain(t('common_error'));
		// Claiming "signed out everywhere" after a failed rotation is the one
		// outcome that actively misleads the user about a lost device.
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
	});

	// It signs this device out too, and the wipe takes the outbox ([D-293]).
	it('says that unsent changes on this device are lost', async () => {
		await putSynced([makeItem({ id: 'item-1', list: 'list-1', name: 'Milch' })]);
		await queueOp({
			op_id: 'op-1',
			collection: 'items',
			record_id: 'item-1',
			list_id: 'list-1',
			type: 'update',
			changed: { quantity: '2' },
			base: { quantity: '' },
			queued_at: new Date().toISOString()
		});
		render(SignOutGroup);
		await untilLoaded(outbox(''));

		await fireEvent.click(screen.getByRole('button', { name: 'Überall abmelden' }));

		const dialog = await screen.findByRole('alertdialog');
		expect(dialog.textContent).toContain('gehen dabei verloren');
		expect(dialog.textContent).not.toContain('Deine Listen bleiben erhalten');
	});

	// Graded severity ([D-214]): it can be undone by signing in again.
	it('stays neutral, not red', () => {
		render(SignOutGroup);

		const row = screen.getByRole('button', { name: 'Überall abmelden' });
		expect(row.innerHTML).not.toContain('text-danger');
	});
});
