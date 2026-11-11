// The resize grip is a mouse's tool: under a finger (pointer: coarse) the
// field shows none, while a mouse keeps it.
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Textarea from './textarea.svelte';

describe('Textarea', () => {
	it('drops the resize grip on a touch screen only', () => {
		const { container } = render(Textarea, { 'aria-label': 'Liste' });
		const field = container.querySelector('textarea')!;
		expect(field.classList).toContain('pointer-coarse:resize-none');
		expect(field.classList).not.toContain('resize-none');
	});
});
