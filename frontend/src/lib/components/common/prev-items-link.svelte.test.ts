// [D-86]: the shared previous-items door. The gating contract is the §6.10
// difference between the two views — the list view must ALWAYS show the link
// (only rows checked 7+ days ago count, so on a young list the entry point
// would otherwise vanish with no other route to the screen), while the shop
// view links only when something has actually aged out.
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import PrevItemsLink from './PrevItemsLink.svelte';

describe('PrevItemsLink', () => {
	it('renders nothing at count 0 unless always', () => {
		const { container } = render(PrevItemsLink, {
			props: { listId: 'list-1', count: 0 }
		});
		expect(container.querySelector('.prev-link')).toBeNull();
	});

	it('always renders in the list view even at count 0', () => {
		const { container } = render(PrevItemsLink, {
			props: { listId: 'list-1', count: 0, always: true }
		});
		expect(container.querySelector('.prev-link')).not.toBeNull();
		expect(screen.getByRole('button')).toBeDefined();
	});

	// [D-128]: the full-bleed rule IS the section break, so the door carries no
	// top margin: the list's last row paints no rule of its own, so a gap there
	// would be a hole in the scroll.
	it('sits directly under the list, with only its rule between', () => {
		const { container } = render(PrevItemsLink, {
			props: { listId: 'list-1', count: 1, always: true }
		});
		const group = container.querySelector<HTMLElement>('.prev-link')!;
		expect(group.querySelector('.border-t')).not.toBeNull();
		expect(group.className).not.toMatch(/(^|\s)mt-/);
	});

	it('carries the count only when there is one', () => {
		render(PrevItemsLink, { props: { listId: 'list-1', count: 5, always: true } });
		expect(screen.getByTestId('prev-n').textContent).toContain('5');
	});
});
