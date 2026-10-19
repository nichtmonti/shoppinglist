// The app shell's error boundary renders ErrorView with the boundary's reset
// (routes/+layout.svelte). A boundary stays failed until reset, so leaving
// the screen that threw by a client-side navigation (Back) must reset it, or
// the error view stays over the next route.
import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto, historyBack, resetHistory } from '#lib/test-kit/app-state.svelte.js';
import ErrorView from './ErrorView.svelte';

beforeEach(() => resetHistory('/'));

describe('ErrorView', () => {
	it('resets the boundary once the user navigates away from the screen that threw', async () => {
		await goto('/list/a');
		const reset = vi.fn();
		render(ErrorView, { props: { detail: 'boom', reset } });
		flushSync();
		expect(screen.getByRole('alert')).toBeDefined();
		expect(reset).not.toHaveBeenCalled();

		historyBack();
		flushSync();

		expect(reset).toHaveBeenCalledTimes(1);
	});

	it('the error page, which has no boundary to reset, renders without one', () => {
		render(ErrorView, { props: { detail: 'boom' } });
		expect(screen.getByRole('alert')).toBeDefined();
	});
});
