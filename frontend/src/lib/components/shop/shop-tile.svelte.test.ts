// ShopTile measures whether its text is cut ([D-83]). Every Dexie emission
// hands it a new item object; only a change the tile shows may re-measure,
// or every tile on the grid does layout work on every edit anywhere.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeItem } from '#lib/test-kit/db.js';
import ShopTile from './ShopTile.svelte';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ShopTile measurement', () => {
	it('re-measures when the shown text changes, not when only the object does', () => {
		const measure = vi.spyOn(Element.prototype, 'scrollHeight', 'get');
		const item = makeItem({ list: 'list-1', name: 'Milch', note: 'die frische', quantity: '2' });
		// Mounted on a $state props object, as a parent passes props: assigning
		// `item` changes that prop alone.
		const props = $state({ item });
		const tile = mount(ShopTile, { target: document.body, props });
		try {
			flushSync();

			measure.mockClear();
			props.item = { ...item };
			flushSync();
			expect(measure).not.toHaveBeenCalled();

			props.item = { ...item, name: 'Vollmilch' };
			flushSync();
			expect(measure).toHaveBeenCalled();
		} finally {
			void unmount(tile);
		}
	});

	it('re-measures when the shop says the line may have changed', () => {
		const measure = vi.spyOn(Element.prototype, 'scrollHeight', 'get');
		const props = $state({ item: makeItem({ list: 'list-1', name: 'Milch' }), remeasure: 0 });
		const tile = mount(ShopTile, { target: document.body, props });
		try {
			flushSync();
			measure.mockClear();
			props.remeasure++;
			flushSync();
			expect(measure).toHaveBeenCalled();
		} finally {
			void unmount(tile);
		}
	});
});

describe('ShopTile photo scrim ([D-83])', () => {
	// happy-dom has no layout: stand in a tile 104px tall whose text block starts
	// 60px above its foot.
	function fakeLayout() {
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: Element
		) {
			const r = (top: number, bottom: number) =>
				({ top, bottom, left: 0, right: 160, width: 160, height: bottom - top }) as DOMRect;
			if (this.classList.contains('tile')) return r(0, 104);
			if (this.classList.contains('tile-text')) return r(44, 80);
			return r(0, 0);
		});
	}

	it('anchors the scrim to where the text block starts on a photo tile', () => {
		fakeLayout();
		const item = makeItem({
			list: 'list-1',
			name: 'Bio Vollmilch',
			barcode: '4000000000001',
			image_url: 'https://images.example/milch.jpg'
		});
		const tile = mount(ShopTile, { target: document.body, props: { item } });
		try {
			flushSync();
			const el = document.querySelector<HTMLElement>('[data-testid="tile"]')!;
			// 104 - 44 = 60px above the foot, plus 4px of lead for the shadow.
			expect(el.style.getPropertyValue('--tile-text-top')).toBe('64px');
		} finally {
			void unmount(tile);
		}
	});

	it('sets nothing on a typed tile, which has no scrim', () => {
		fakeLayout();
		const item = makeItem({ list: 'list-1', name: 'Butter' });
		const tile = mount(ShopTile, { target: document.body, props: { item } });
		try {
			flushSync();
			const el = document.querySelector<HTMLElement>('[data-testid="tile"]')!;
			expect(el.style.getPropertyValue('--tile-text-top')).toBe('');
		} finally {
			void unmount(tile);
		}
	});
});
