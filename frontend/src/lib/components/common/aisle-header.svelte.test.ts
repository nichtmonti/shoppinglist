// [D-86]: the shared aisle header — one implementation for the shop view's
// tile groups and the list view's by-category rows. The contract that made
// the extraction necessary: the vertical padding MUST come from --aisle-py
// (the list view's copy had hardcoded py-2.25 and silently ignored the
// [D-83] density tokens), and the tint ratios are the WCAG-pinned pair
// (cat-text-65 count pill on cat-surface-14 over the row's cat-surface-12).
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import { makeCategory } from '#lib/test-kit/db.js';
import AisleHeader from './AisleHeader.svelte';
import { emojiAsset } from '#lib/emoji.js';

const category = makeCategory({
	list: 'list-1',
	slug: 'produce',
	name: 'Obst & Gemüse',
	icon: '🥦',
	color: 'green',
	sort_order: 1
});

describe('AisleHeader', () => {
	it('renders name, emoji, count and the per-category tint variable', () => {
		const { container } = render(AisleHeader, {
			props: { title: 'Obst & Gemüse', icon: category.icon, color: category.color, count: 7 }
		});

		expect(screen.getByText('Obst & Gemüse')).toBeTruthy();
		// The icon is OpenMoji's artwork for 🥦 (U+1F966), not the text ([D-181]).
		expect(container.querySelector('.aisle-emoji img')?.getAttribute('src')).toBe(emojiAsset('🥦'));
		expect(screen.getByText('7')).toBeTruthy();

		const head = container.querySelector('.cat-head');
		expect(head?.getAttribute('style')).toContain('--c:'); // categoryStyle's tint input
	});

	it('takes its vertical padding from the density token, not a hard value', () => {
		const { container } = render(AisleHeader, {
			props: { title: 'Obst', icon: category.icon, color: category.color, count: 1 }
		});
		const head = container.querySelector('.cat-head');
		// [D-83]: compact retunes --aisle-py on the root; the header must follow
		// the token rather than hardcode a padding.
		expect(head?.className).toContain('py-(--aisle-py)');
	});

	it('carries the AA-pinned count-pill tint classes', () => {
		const { container } = render(AisleHeader, {
			props: { title: 'Obst', icon: category.icon, color: category.color, count: 3 }
		});
		const pill = container.querySelector('.cat-head-count');
		expect(pill?.className).toContain('cat-text-65');
		expect(pill?.className).toContain('cat-surface-14');
	});

	it('draws a settings group without a count, and does not stick', () => {
		const { container } = render(AisleHeader, {
			props: { title: 'Konto', icon: category.icon, color: category.color, sticky: false }
		});
		const head = container.querySelector('.cat-head');
		expect(head?.classList.contains('sticky')).toBe(false);
		expect(container.querySelector('.cat-head-count')).toBeNull();
	});
});
