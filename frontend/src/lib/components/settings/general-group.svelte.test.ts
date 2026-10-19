// GeneralGroup — locale and theme (the hidden-suggestions row is
// hidden-suggestions-sheet's). The shop-grid density lives in the list
// settings sheet; its tests are with that control.
// No pb/auth mocks needed: the prefs stores are real (Dexie-backed liveQuery),
// which is the point — the locale switch must exercise the real persistence
// path.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from '#lib/test-kit/db.js';
import { localePref } from '#lib/state/prefs.js';
import { mode, resetMode } from 'mode-watcher';
import GeneralGroup from './GeneralGroup.svelte';

beforeEach(async () => {
	await resetDb();
});

describe('GeneralGroup', () => {
	it('switches the locale via setLocalePref', async () => {
		render(GeneralGroup);

		await fireEvent.click(screen.getByRole('radio', { name: 'Deutsch' }));

		await waitFor(() => {
			expect(screen.getByRole('radio', { name: 'Deutsch' }).getAttribute('aria-checked')).toBe(
				'true'
			);
		});
		await waitFor(() => {
			let current: string | undefined;
			localePref.subscribe((v) => (current = v))();
			expect(current).toBe('de');
		});
	});

	it('switches the theme via mode-watcher setMode', async () => {
		render(GeneralGroup);

		// Click 'Hell' — radio semantics never deselect, so this drives
		// setMode('light') and checks the chip.
		const light = screen.getByRole('radio', { name: 'Hell' });
		await fireEvent.click(light);

		await waitFor(() => {
			expect(screen.getByRole('radio', { name: 'Hell' }).getAttribute('aria-checked')).toBe('true');
		});
		// mode-watcher's persisted preference proves the wiring reached
		// setMode, not just the chip state. (The document-level color-scheme
		// application is the ModeWatcher component's job — not mounted here.)
		expect(mode.current).toBe('light');
	});

	// mode-watcher's resolved `mode.current` is only ever light or dark; the
	// control shows the user's choice, so "System" reads as chosen.
	it('shows "System" as chosen while the theme follows the system', async () => {
		resetMode();
		render(GeneralGroup);

		await waitFor(() =>
			expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe(
				'true'
			)
		);
	});
});
