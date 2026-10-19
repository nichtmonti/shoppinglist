// Segmented wraps bits-ui's ToggleGroup type="single", which lets a tap on the
// ACTIVE item deselect it. The wrapper must hold the selection on the value
// its caller passed, not only swallow the empty string it reports: before
// bits-ui's own state went to '' on that tap while the caller's value
// stayed put, so NO segment rendered as selected — the view toggle read
// neither „Einkaufen" nor „Bearbeiten" while the shop view was on screen.
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
});
