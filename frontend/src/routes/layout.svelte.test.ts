// The app shell's error boundary ([D-197]): a screen that throws after it
// loaded never reaches +error.svelte, so the shell catches it, shows the error
// view and reports it. Boot's side effects (session, sync, locale, storage)
// are mocked: this file owns the boundary, not them.
import { render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock({}, { nickname: 'Anna' });
});
vi.mock('#lib/sync/index.js', () => ({ mountSync: vi.fn(), unmountSync: vi.fn() }));
vi.mock('#lib/state/auth-methods.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/state/auth-methods.js')>()),
	refreshAuthMethods: vi.fn(async () => true)
}));
vi.mock('#lib/storage.js', () => ({ requestPersistentStorage: vi.fn(async () => true) }));
vi.mock('#lib/state/prefs.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/state/prefs.js')>()),
	loadLocale: vi.fn(async () => {})
}));
vi.mock('#lib/state/suppression.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/state/suppression.js')>()),
	refreshSuppressedMirror: vi.fn(async () => {}),
	flushSuppressed: vi.fn(async () => {})
}));
vi.mock('#lib/client-errors.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/client-errors.js')>()),
	reportClientError: vi.fn()
}));

import { reportClientError } from '#lib/client-errors.js';
import { authState } from '#lib/auth/index.js';
import { refreshSuppressedMirror } from '#lib/state/suppression.js';
import { db, setMeta } from '#lib/db.js';
import { getLocale, t } from '#lib/i18n/index.js';
import * as appState from '#lib/test-kit/app-state.svelte.js';
import Layout from './+layout.svelte';

// The screen under the shell: it renders, and throws once `broken` is set,
// as a screen does whose data turns into something it cannot render.
const screenState = $state({ broken: false });
const children = createRawSnippet(() => ({
	render: () => '<p data-testid="page">Wocheneinkauf</p>',
	setup: () => {
		$effect(() => {
			if (screenState.broken) throw new Error('item.name is undefined');
		});
	}
}));

beforeEach(async () => {
	vi.clearAllMocks();
	screenState.broken = false;
	await appState.goto('/list/list-a');
	appState.page.route = { id: '/list/[id]' };
});

describe('the app shell', () => {
	it('shows the error view and reports a screen that throws after it loaded', async () => {
		render(Layout, { props: { children } });
		await screen.findByTestId('page');

		screenState.broken = true;
		flushSync();

		expect(screen.queryByTestId('page')).toBeNull();
		expect(screen.getByRole('alert').textContent).toContain('Etwas ist schiefgelaufen.');
		expect(screen.getByRole('button', { name: 'Neu laden' })).toBeDefined();
		expect(screen.getByTestId('error-detail').textContent).toContain('item.name is undefined');
		expect(reportClientError).toHaveBeenCalledTimes(1);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining('item.name is undefined'),
				route: '/list/[id]',
				path: '/list/list-a',
				status: 500,
				context: 'render'
			})
		);
	});
});

// [D-291] Another tab's language switch arrives as a `meta.locale` write
// (Dexie's liveQuery crosses tabs). The strings follow in place: the screen
// is not remounted, so nothing it holds is lost.
describe('a language switch from another tab', () => {
	beforeEach(async () => {
		await db.meta.delete('locale');
	});

	it('relabels the screen in place, without remounting it', async () => {
		let mounts = 0;
		const translated = createRawSnippet(() => ({
			render: () => '<p data-testid="page"></p>',
			setup: (node) => {
				mounts++;
				$effect(() => {
					node.textContent = t('share_join_title');
				});
			}
		}));
		render(Layout, { props: { children: translated } });
		await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('Liste beitreten'));

		await setMeta('locale', 'en');

		await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('Join list'));
		expect(getLocale()).toBe('en');
		expect(document.documentElement.lang).toBe('en');
		expect(mounts).toBe(1);
	});
});

describe('hidden suggestions (§6.11)', () => {
	// A sign-in on a new device happens after boot, which mirrors the account's
	// hidden names only for a session it finds: without them every hidden name
	// is offered, and adding one would not unhide it.
	it('mirrors them for a session that starts after boot', async () => {
		authState.set({ nickname: null, isValid: false });
		render(Layout, { props: { children } });
		await waitFor(() => expect(refreshSuppressedMirror).toHaveBeenCalled());
		vi.mocked(refreshSuppressedMirror).mockClear();

		authState.set({ nickname: 'Anna', isValid: true });
		flushSync();

		// Loaded on demand, off the boot path ([D-203]).
		await waitFor(() => expect(refreshSuppressedMirror).toHaveBeenCalledTimes(1));
	});
});
