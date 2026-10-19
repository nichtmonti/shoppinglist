// The hidden-suggestions row and its sheet — §6.11's secondary "review and
// restore" path, entered from GeneralGroup's row ([D-269]). #lib/db
// and the prefs stores stay real (the restore must exercise the Dexie mirror +
// the own-row push), only #lib/pb is mocked.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accountsUpdate, accountsGetOne } = vi.hoisted(() => ({
	accountsUpdate: vi.fn(),
	accountsGetOne: vi.fn()
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		collections: { accounts: { update: accountsUpdate, getOne: accountsGetOne } }
	});
});

import { db } from '#lib/db.js';
import { resetDb } from '#lib/test-kit/db.js';
import GeneralGroup from './GeneralGroup.svelte';

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	accountsUpdate.mockImplementation(async (id: string, body: object) => ({ id, ...body }));
	accountsGetOne.mockResolvedValue({
		id: 'account-1',
		suppressed_names: ['sonnencreme', 'katzenstreu']
	});
});

describe('the hidden suggestions', () => {
	// §6.11 names TWO un-suppression paths. The zero-friction one (re-adding the
	// name) lives in the add box and is covered by add-bar.svelte.test.ts; this
	// is the secondary "review and restore" screen, which matters precisely
	// because a suppressed name is no longer reachable from the typeahead.
	it('lists hidden suggestions and restores one on tap (§6.11)', async () => {
		await db.meta.put({ key: 'suppressed_names', value: ['sonnencreme', 'katzenstreu'] });

		render(GeneralGroup);

		// The row counts them and opens the sheet.
		await fireEvent.click(
			await screen.findByRole('button', { name: /^Ausgeblendete Vorschläge\s*2$/ })
		);
		await waitFor(() => {
			expect(screen.getByText('sonnencreme')).toBeDefined();
			expect(screen.getByText('katzenstreu')).toBeDefined();
		});

		const rows = screen.getAllByRole('button', { name: 'Wieder vorschlagen' });
		expect(rows).toHaveLength(2);
		// Each says which name it brings back, for a screen reader tabbing through.
		const describedBy = rows.map(
			(r) => document.getElementById(r.getAttribute('aria-describedby') ?? '')?.textContent
		);
		expect(describedBy).toEqual(['sonnencreme', 'katzenstreu']);
		await fireEvent.click(rows[0]);

		// Removed from the Dexie mirror (instant + offline) AND pushed to the
		// account on the own-row path — the preference follows the user's devices.
		await waitFor(async () => {
			expect((await db.meta.get('suppressed_names'))?.value).toEqual(['katzenstreu']);
		});
		await waitFor(() => {
			expect(accountsUpdate).toHaveBeenCalledWith('account-1', {
				suppressed_names: ['katzenstreu']
			});
		});
		await waitFor(() => {
			expect(screen.queryByText('sonnencreme')).toBeNull();
		});
	});

	// Decided once the mirror has answered, so "keine" never flashes ([D-214]).
	it('says "keine", and opens nothing, when nothing is suppressed', async () => {
		render(GeneralGroup);

		await waitFor(() => {
			expect(screen.getByText('keine')).toBeDefined();
		});
		expect(screen.queryByRole('button', { name: /Ausgeblendete Vorschläge/ })).toBeNull();
	});
});
