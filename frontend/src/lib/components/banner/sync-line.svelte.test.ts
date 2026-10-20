// [D-296] The line under a list's name: the members while the sync is fine,
// else what is wrong, and a tap that explains it and offers the one thing
// that helps.
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'svelte/store';
import { db } from '#lib/db.js';
import { resetDb } from '#lib/test-kit/db.js';

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock();
});
vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	return { online: writable(true) };
});
vi.mock('#lib/sync/index.js', async (importOriginal) => {
	const { writable } = await import('svelte/store');
	return {
		...(await importOriginal<typeof import('#lib/sync/index.js')>()),
		leading: writable(true),
		syncNow: vi.fn()
	};
});

import { online } from '#lib/state/online.js';
import { leading, syncNow } from '#lib/sync/index.js';
import { SYNC_HEALTH_KEY } from '#lib/sync/health.js';
import SyncLine from './SyncLine.svelte';
import { isoAgo } from '#lib/test-kit/time.js';

const LIST = 'list-1';
const MEMBERS = 'geteilt · 2 Mitglieder';

async function waiting(count: number, sinceMs: number): Promise<void> {
	await db.pending_ops.bulkPut(
		Array.from({ length: count }, (_, i) => ({
			op_id: `op-${i}`,
			collection: 'items' as const,
			record_id: `item-${i}`,
			list_id: LIST,
			type: 'update' as const,
			changed: { quantity: '2' },
			base: { quantity: '' },
			stamps: {},
			queued_at: isoAgo(sinceMs)
		}))
	);
}

async function health(h: {
	ok_at?: string | null;
	started_at?: string | null;
	failures?: number;
	reason?: string | null;
}) {
	await db.meta.put({
		key: SYNC_HEALTH_KEY,
		value: { ok_at: isoAgo(1_000), started_at: isoAgo(1_000), failures: 0, reason: null, ...h }
	});
}

// The status gives a page just loaded 20 s before it calls a sender stuck:
// these tests' page loaded a moment ago, so its clock moves a minute on.
function aMinuteLater(): void {
	const later = Date.now() + 60_000;
	vi.spyOn(Date, 'now').mockReturnValue(later);
}

afterEach(() => {
	vi.restoreAllMocks();
});

beforeEach(async () => {
	await resetDb();
	(online as Writable<boolean>).set(true);
	(leading as unknown as Writable<boolean>).set(true);
	vi.mocked(syncNow).mockClear();
});

describe('SyncLine', () => {
	it('shows the members while the sync is fine, and opens them on a tap', async () => {
		await health({});
		const onmembers = vi.fn();
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers });

		const line = await screen.findByTestId('members-line');
		expect(line.textContent).toContain(MEMBERS);
		expect(screen.queryByTestId('sync-line')).toBeNull();
		await fireEvent.click(line);
		expect(onmembers).toHaveBeenCalledTimes(1);
	});

	it('says why changes are not sent, and sends them now on request', async () => {
		await waiting(3, 30_000);
		await health({ started_at: isoAgo(2_000), failures: 3, reason: 'server' });
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		const line = await screen.findByTestId('sync-line');
		expect(line.textContent).toContain('Server antwortet nicht');
		await fireEvent.click(line);

		const sheet = await screen.findByRole('dialog', { name: '3 Änderungen nicht synchronisiert' });
		expect(sheet.textContent).toContain('Der Server antwortet gerade nicht.');
		await fireEvent.click(within(sheet).getByRole('button', { name: 'Jetzt synchronisieren' }));
		expect(syncNow).toHaveBeenCalledTimes(1);
	});

	it('sends the user to the other tab, with nothing to press here', async () => {
		aMinuteLater();
		(leading as unknown as Writable<boolean>).set(false);
		await waiting(2, 60_000);
		await health({ started_at: isoAgo(60_000) });
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		const line = await screen.findByTestId('sync-line');
		expect(line.textContent).toContain('Wartet auf anderen Tab');
		await fireEvent.click(line);
		const sheet = await screen.findByRole('dialog', {
			name: 'Änderungen warten auf einen anderen Tab'
		});
		expect(within(sheet).queryByRole('button', { name: /senden|laden/i })).toBeNull();
	});

	it('offers a reload when this tab has stopped sending', async () => {
		aMinuteLater();
		await waiting(2, 60_000);
		await health({ started_at: isoAgo(60_000) });
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		expect((await screen.findByTestId('sync-line')).textContent).toContain('App hängt · neu laden');
	});

	it('says the sync is broken, in amber, when the app itself fails, and offers a reload', async () => {
		await health({ started_at: isoAgo(3_000), failures: 3, reason: 'app' });
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		const line = await screen.findByTestId('sync-line');
		expect(line.textContent).toContain('Sync-Fehler · neu laden');
		expect(line.className).toContain('text-amber');
		await fireEvent.click(line);
		const sheet = await screen.findByRole('dialog', { name: 'Die Synchronisierung klappt nicht' });
		expect(within(sheet).getByRole('button', { name: 'Neu laden' })).toBeTruthy();
	});

	it('sends the user to the leading tab when the sync is broken there', async () => {
		(leading as unknown as Writable<boolean>).set(false);
		await health({ started_at: isoAgo(3_000), failures: 3, reason: 'app' });
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		await fireEvent.click(await screen.findByTestId('sync-line'));
		const sheet = await screen.findByRole('dialog', { name: 'Die Synchronisierung klappt nicht' });
		expect(sheet.textContent).toContain('Ein anderer Tab der App');
		expect(within(sheet).queryByRole('button', { name: 'Neu laden' })).toBeNull();
	});

	it('says how old what is shown is, in grey, when the server has not answered', async () => {
		await health({
			ok_at: isoAgo(25 * 60_000),
			started_at: isoAgo(3_000),
			failures: 6,
			reason: 'connection'
		});
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		const line = await screen.findByTestId('sync-line');
		expect(line.textContent).toContain('Stand: vor 25 Min.');
		expect(line.className).not.toContain('text-amber');
	});

	it('says offline, and since when', async () => {
		(online as Writable<boolean>).set(false);
		await health({ ok_at: isoAgo(25 * 60_000) });
		render(SyncLine, { listId: LIST, members: MEMBERS, onmembers: vi.fn() });

		expect((await screen.findByTestId('sync-line')).textContent).toContain('Offline · vor 25 Min.');
	});
});
