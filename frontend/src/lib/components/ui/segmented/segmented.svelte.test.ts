// Segmented is a radio group: one choice, never none. A tap on the active
// segment must leave it selected (the ToggleGroup it was built on once let it
// go, and the view toggle then read neither „Einkaufen" nor „Bearbeiten"),
// and the arrow keys choose, as in any radio group.
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import Segmented from './segmented.svelte';

const OPTIONS = [
	{ value: 'shop', label: 'Einkaufen' },
	{ value: 'list', label: 'Bearbeiten' }
];

function renderSegmented(value = 'shop') {
	const onchange = vi.fn();
	render(Segmented, { value, options: OPTIONS, onchange, label: 'Ansicht', testid: 'seg' });
	return { onchange, shop: screen.getByTestId('seg-shop'), list: screen.getByTestId('seg-list') };
}

describe('Segmented', () => {
	it('reports a new choice', async () => {
		const { onchange, list } = renderSegmented();
		await fireEvent.click(list);
		expect(onchange).toHaveBeenCalledWith('list');
	});

	it('keeps the active segment selected when it is tapped again', async () => {
		const { onchange, shop, list } = renderSegmented();
		expect(shop.getAttribute('aria-checked')).toBe('true');

		await fireEvent.click(shop);

		expect(onchange).not.toHaveBeenCalled();
		expect(shop.getAttribute('aria-checked')).toBe('true');
		expect(list.getAttribute('aria-checked')).toBe('false');
	});

	it('chooses the next segment with an arrow key', async () => {
		const { onchange, shop } = renderSegmented();
		shop.focus();
		await fireEvent.keyDown(shop, { key: 'ArrowRight' });
		expect(onchange).toHaveBeenCalledWith('list');
	});
});
