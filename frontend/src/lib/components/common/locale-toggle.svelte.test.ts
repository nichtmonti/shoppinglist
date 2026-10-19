// LocaleToggle — the §12.2 de/en switch on its own. Settings and the
// signed-out surfaces (AuthScreen, and /join through it) carry it; this spec
// pins the component's own contract rather than any surface's.
//
// No pb/auth mocks, as in settings/general-group.svelte.test.ts: the prefs store and
// Dexie are real, because every surface shares ONE persistence path —
// stubbing it would test nothing.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from '#lib/test-kit/db.js';
import { getMeta } from '#lib/db.js';
import LocaleToggle from './LocaleToggle.svelte';

beforeEach(async () => {
	await resetDb();
});

describe('LocaleToggle', () => {
	it('renders one radio per locale in a labelled group', () => {
		render(LocaleToggle);

		// The group name is what a screen reader announces for the pair;
		// the item labels are locale-independent ('Deutsch'/'English' in
		// both catalogs), so the switch can be found before it is used.
		expect(screen.getByRole('group', { name: 'Sprache' })).toBeDefined();
		expect(screen.getByRole('radio', { name: 'Deutsch' })).toBeDefined();
		expect(screen.getByRole('radio', { name: 'English' })).toBeDefined();
	});

	it('persists a choice through the shared preference path', async () => {
		render(LocaleToggle);

		// 'Deutsch', not 'English': the happy-dom navigator asks for en-US, so the
		// English chip is ALREADY the active value here — and a single-toggle
		// group DESELECTS on a second click, which the value guard below
		// deliberately ignores. Only a genuine change exercises the write.
		await fireEvent.click(screen.getByRole('radio', { name: 'Deutsch' }));

		// meta.locale is the store every surface goes through — asserting the
		// row itself (not just the chip state) proves the write landed.
		await waitFor(async () => expect(await getMeta('locale')).toBe('de'));
		await waitFor(() =>
			expect(screen.getByRole('radio', { name: 'Deutsch' }).getAttribute('aria-checked')).toBe(
				'true'
			)
		);
		// Single-select: the other chip must give up its checked state.
		await waitFor(() =>
			expect(screen.getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe(
				'false'
			)
		);
	});

	it('defaults its testid to the settings surface', () => {
		render(LocaleToggle);

		expect(screen.getByTestId('settings-locale')).toBeDefined();
	});

	// Two instances can be on the page at once across surfaces; the prop is
	// what keeps the tests (and any future second instance) from colliding.
	it('carries the testid prop so two instances cannot collide', () => {
		render(LocaleToggle, { testid: 'auth-locale' });

		expect(screen.getByTestId('auth-locale')).toBeDefined();
		expect(screen.queryByTestId('settings-locale')).toBeNull();
	});
});
