// §9.1 the row's inline quantity editor ([D-268]): Enter or tapping elsewhere
// saves what was typed, Escape drops it, and an edit left as it started sends
// nothing (§8.4).
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import { makeItem } from '#lib/test-kit/db.js';
import QuantityControl from './QuantityControl.svelte';

async function typeQuantity(value: string, quantity = '') {
	const oncommit = vi.fn();
	render(QuantityControl, { item: makeItem({ list: 'L', name: 'Käse', quantity }), oncommit });
	await fireEvent.click(screen.getByRole('button'));
	const input = screen.getByRole('textbox', { name: 'Menge bearbeiten' });
	await fireEvent.input(input, { target: { value } });
	return { oncommit, input };
}

describe('QuantityControl', () => {
	it('saves what was typed when the user taps elsewhere', async () => {
		const { oncommit, input } = await typeQuantity('3 Stück');
		await fireEvent.blur(input);
		expect(oncommit).toHaveBeenCalledExactlyOnceWith('3 Stück');
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('saves on Enter, once, though leaving the field blurs it too', async () => {
		const { oncommit, input } = await typeQuantity('1 Kilo');
		await fireEvent.keyDown(input, { key: 'Enter' });
		await fireEvent.blur(input);
		expect(oncommit).toHaveBeenCalledExactlyOnceWith('1 Kilo');
	});

	it('drops the edit on Escape', async () => {
		const { oncommit, input } = await typeQuantity('5');
		await fireEvent.keyDown(input, { key: 'Escape' });
		await fireEvent.blur(input);
		expect(oncommit).not.toHaveBeenCalled();
	});

	it('sends nothing for an edit left as it started', async () => {
		const { oncommit, input } = await typeQuantity('2', '2');
		await fireEvent.blur(input);
		expect(oncommit).not.toHaveBeenCalled();
	});
});
