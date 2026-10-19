// The leave confirmation warns when this account is the last member, since
// leaving then deletes the list for everyone (§7.3, [D-293]). It counts the
// cached roster, read again on open: a cache from the morning still counts a
// member who left at noon.
import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/sync/roster.js', () => ({ refreshRoster: vi.fn() }));

import { db } from '#lib/db.js';
import { resetDb } from '#lib/test-kit/db.js';
import { refreshRoster } from '#lib/sync/roster.js';
import LeaveListDialog from './LeaveListDialog.svelte';

const member = (account: string, nickname: string) => ({
	id: `list-1_${account}`,
	list: 'list-1',
	account,
	nickname,
	joined: '2026-01-01T00:00:00.000Z'
});

function renderSheet(open: boolean) {
	render(LeaveListDialog, {
		open,
		listId: 'list-1',
		name: 'Wocheneinkauf',
		busy: false,
		error: undefined,
		onconfirm: vi.fn(),
		oncancel: vi.fn()
	});
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	await db.roster.bulkPut([member('me', 'Anna'), member('ben', 'Ben')]);
});

describe('LeaveListDialog', () => {
	it('reads the members again on open, and warns once this account is the last', async () => {
		// Ben left since the roster was cached.
		vi.mocked(refreshRoster).mockImplementation(async () => {
			await db.roster.delete('list-1_ben');
			return [];
		});
		renderSheet(true);

		expect(
			await screen.findByText(/Du bist das einzige Mitglied von „Wocheneinkauf“/)
		).toBeDefined();
		expect(refreshRoster).toHaveBeenCalledWith('list-1');
	});

	it('asks plainly while others are on the list', async () => {
		vi.mocked(refreshRoster).mockResolvedValue([]);
		renderSheet(true);

		expect(await screen.findByText('„Wocheneinkauf“ wirklich verlassen?')).toBeDefined();
	});

	it('reads nothing while closed', () => {
		renderSheet(false);
		expect(refreshRoster).not.toHaveBeenCalled();
	});
});
