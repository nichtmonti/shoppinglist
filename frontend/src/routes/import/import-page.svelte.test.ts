// [D-254] The share target's /import?text=…&title=… route. Some apps share a
// whole list as the subject with no body: a title of several lines and no text
// is the list, while a one-line title is only a name for whatever is pasted.
// The screen behind it has its own suite (text-import-screen.svelte.test.ts);
// this one owns how the route reads the share's two fields.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	return { online: writable(true), isOnline: () => true };
});

vi.mock('#lib/actions/lists.js', async (importOriginal) => ({
	importFailureMessage: (await importOriginal<typeof import('#lib/actions/lists.js')>())
		.importFailureMessage,
	importBackup: vi.fn(),
	importListFromFile: vi.fn()
}));
vi.mock('#lib/actions/items.js', () => ({ addImported: vi.fn() }));

import { db } from '#lib/db.js';
import { makeTemplate, resetDb } from '#lib/test-kit/db.js';
import { historyEntries, page, resetHistory } from '#lib/test-kit/app-state.svelte.js';
import Page from './+page.svelte';

/** The review's item names, in order. */
function reviewNames(): string[] {
	return [...document.querySelectorAll('[data-import-row] [id^="import-name-"]')].map((el) =>
		el.textContent.trim()
	);
}

beforeEach(async () => {
	await resetDb();
	await db.category_templates.bulkPut([makeTemplate({ slug: 'other', sort_order: 21 })]);
});

describe('/import, shared as a title only', () => {
	it('reads a title of several lines and no text as the list', async () => {
		resetHistory('/import?title=Milch%0ABrot');
		render(Page);

		await screen.findByRole('button', { name: 'Liste mit 2 Artikeln erstellen' });
		await waitFor(() => expect(reviewNames()).toEqual(['Milch', 'Brot']));
		// The list, not its name: the name is the default one.
		expect(screen.getByLabelText<HTMLInputElement>('Name der neuen Liste').value).toBe(
			'Importierte Liste'
		);
		// The share is out of the address bar, and no history entry carries it.
		expect(page.url.search).toBe('');
		expect(historyEntries().urls.some((url) => String(url).includes('title='))).toBe(false);
	});

	it("reads a one-line title as the new list's name, for the text still to paste", async () => {
		resetHistory('/import?title=Wochenmarkt');
		render(Page);

		const text = await screen.findByLabelText<HTMLTextAreaElement>('Liste als Text');
		expect(text.value).toBe('');
		expect(reviewNames()).toEqual([]);

		await fireEvent.input(text, { target: { value: 'Milch\nBrot\n' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
		await screen.findByRole('button', { name: 'Liste mit 2 Artikeln erstellen' });
		expect(screen.getByLabelText<HTMLInputElement>('Name der neuen Liste').value).toBe(
			'Wochenmarkt'
		);
	});
});
