import { describe, expect, it } from 'vitest';
import { Kept } from './kept.svelte';

describe('Kept', () => {
	it('follows the open value, and keeps the last one after it goes null', () => {
		let open = $state<string | null>(null);
		const kept = new Kept(() => open);
		expect(kept.value).toBeNull();

		open = 'a';
		expect(kept.value).toBe('a');
		open = 'b';
		expect(kept.value).toBe('b');
		open = null;
		expect(kept.value).toBe('b');
		open = 'c';
		expect(kept.value).toBe('c');
	});
});
