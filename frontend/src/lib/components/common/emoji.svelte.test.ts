import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import { emojiAsset } from '#lib/emoji.js';
import Emoji from './Emoji.svelte';

describe('Emoji', () => {
	it('draws the OpenMoji artwork for an emoji in the set ([D-181])', () => {
		const { container } = render(Emoji, { props: { emoji: '🥛', size: 1.5 } });
		const img = container.querySelector('img');
		expect(img?.getAttribute('src')).toBe(emojiAsset('🥛'));
		expect(img?.getAttribute('alt')).toBe('');
		expect(container.querySelector('.emoji')?.getAttribute('style')).toMatch(
			/--emoji: 1\.5(000)?rem/
		);
	});

	it('falls back to the emoji as text when there is no artwork', () => {
		const { container } = render(Emoji, { props: { emoji: '🦄', size: 1 } });
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('.emoji')?.textContent).toBe('🦄');
	});
});
