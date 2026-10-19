// PromptDialog seeds its field once per open. The list rename sheet passes the
// LIVE list name, which SSE can change at any moment (§8.5) — that must not
// overwrite what the user is typing.
import { fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import PromptDialog from './PromptDialog.svelte';

const base = { title: 'Umbenennen', label: 'Name', onsubmit: vi.fn(), oncancel: vi.fn() };

describe('PromptDialog', () => {
	it('keeps the typed draft when the seed value changes while open', async () => {
		const { rerender } = render(PromptDialog, { props: { ...base, open: true, value: 'Alt' } });
		const input = screen.getByLabelText<HTMLInputElement>('Name');
		expect(input.value).toBe('Alt');

		await fireEvent.input(input, { target: { value: 'Mein Entwurf' } });
		await rerender({ ...base, open: true, value: 'Von woanders umbenannt' });
		flushSync();

		expect(input.value).toBe('Mein Entwurf');
	});

	it('re-seeds from the current value on the next open', async () => {
		const { rerender } = render(PromptDialog, { props: { ...base, open: true, value: 'Alt' } });
		await rerender({ ...base, open: false, value: 'Neu' });
		await rerender({ ...base, open: true, value: 'Neu' });

		expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Neu');
	});
});
