// [D-86]: the display-only quantity badge — one type treatment for the
// plain tile chip, the photo tile chip and the done-row text ([D-20]: free
// text, never parsed). The empty-quantity case must render NOTHING (a
// glyphless pill once read as a rendering artifact).
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import QuantityBadge from './QuantityBadge.svelte';

describe('QuantityBadge', () => {
	it('renders nothing for an empty quantity string', () => {
		const { container } = render(QuantityBadge, { props: { quantity: '' } });
		expect(container.querySelector('.qty')).toBeNull();
	});

	it('chip variant: muted foreground on its 12% fill, placed by the tile', () => {
		const { container } = render(QuantityBadge, {
			props: { quantity: '250 g', variant: 'tile' }
		});
		const qty = container.querySelector('.qty');
		expect(qty?.textContent).toBe('250 g');
		expect(qty?.className).toContain('bg-tint-strong');
		// Where the chip sits inside a tile is the tile template's call
		// (app.css, [D-83]): a `self-*` utility here would outrank it.
		expect(qty?.className).not.toMatch(/\bself-/);
	});

	it('photo variant: white text over the scrim', () => {
		const { container } = render(QuantityBadge, {
			props: { quantity: '2', variant: 'tile-photo' }
		});
		const qty = container.querySelector('.qty');
		expect(qty?.className).toContain('text-(--tile-photo-ink)');
		// Stacking it above the photo is the tile template's ([D-83]).
		expect(qty?.className).not.toContain('relative');
	});

	it('passes aria-hidden through, for the tile whose button names the item', () => {
		const { container } = render(QuantityBadge, {
			props: { quantity: '2', variant: 'tile', 'aria-hidden': 'true' }
		});
		expect(container.querySelector('.qty')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('plain variant: unadorned text, no chip fill', () => {
		const { container } = render(QuantityBadge, {
			props: { quantity: '2', variant: 'plain' }
		});
		const qty = container.querySelector('.qty');
		expect(qty?.className).toContain('text-muted-foreground');
		expect(qty?.className).not.toContain('bg-');
	});
});
