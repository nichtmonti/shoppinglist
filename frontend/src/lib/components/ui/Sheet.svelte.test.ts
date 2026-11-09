// The bottom sheet is a bits-ui dialog ([D-348]), which provides modality,
// focus management and Escape, so these tests cover the wrapper contract.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Sheet from './Sheet.svelte';

const children = createRawSnippet(() => ({ render: () => '<p data-testid="body">body</p>' }));
const headerActions = createRawSnippet(() => ({
	render: () => '<button type="button" aria-label="Entfernen">remove</button>'
}));

describe('Sheet — wrapper contract', () => {
	it('renders the title, children and a close button when open', () => {
		render(Sheet, { props: { open: true, title: 'Mein Sheet', onclose: vi.fn(), children } });
		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(screen.getByText('Mein Sheet')).toBeTruthy();
		expect(screen.getByTestId('body')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Schließen' })).toBeTruthy();
	});

	it('closes via the close button', async () => {
		const onclose = vi.fn();
		render(Sheet, { props: { open: true, title: 'Mein Sheet', onclose, children } });
		await fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
		expect(onclose).toHaveBeenCalled();
	});

	it('places optional actions beside the close button in the header', () => {
		render(Sheet, {
			props: { open: true, title: 'Mein Sheet', onclose: vi.fn(), children, headerActions }
		});
		const actions = document.querySelector('.sheet-actions');
		expect(actions).toBeTruthy();
		expect(actions?.querySelectorAll('button')).toHaveLength(2);
		expect(screen.getByRole('button', { name: 'Entfernen' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Schließen' })).toBeTruthy();
	});

	it('renders nothing when closed', () => {
		render(Sheet, { props: { open: false, title: 'Mein Sheet', onclose: vi.fn(), children } });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('leaves moving a focused field above the keyboard to the browser', () => {
		// happy-dom has no visualViewport; a keyboard shim would listen to it.
		// On an iPhone, one beside Safari's own scroll moved the field off the
		// top of the screen.
		const viewport = Object.assign(new EventTarget(), { height: 400, width: 400, offsetTop: 0 });
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
		try {
			const field = createRawSnippet(() => ({ render: () => '<input data-testid="field" />' }));
			render(Sheet, {
				props: { open: true, title: 'Mein Sheet', onclose: vi.fn(), children: field }
			});
			screen.getByTestId('field').focus();
			viewport.dispatchEvent(new Event('resize'));
			const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
			expect(sheet?.style.bottom).toBe('');
		} finally {
			Reflect.deleteProperty(window, 'visualViewport');
		}
	});

	it('closes on Escape', async () => {
		const onclose = vi.fn();
		render(Sheet, { props: { open: true, title: 'Mein Sheet', onclose, children } });
		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(onclose).toHaveBeenCalled());
	});
});
