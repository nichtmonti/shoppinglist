// [D-335] The demo's start screen on an address where the browser withholds
// what the sync needs: it says where to open it instead, and does not start.
import { render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import DemoStart from './DemoStart.svelte';

function secureContext(value: boolean): void {
	Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

describe('DemoStart', () => {
	afterEach(() => secureContext(true));

	it('offers the demo in a secure context', () => {
		secureContext(true);
		render(DemoStart);
		expect(screen.getByTestId<HTMLButtonElement>('demo-start').disabled).toBe(false);
		expect(screen.queryByText(/sperrt/)).toBeNull();
	});

	it('names the localhost address and stays off elsewhere over plain HTTP', () => {
		secureContext(false);
		render(DemoStart);
		expect(screen.getByTestId<HTMLButtonElement>('demo-start').disabled).toBe(true);
		expect(screen.getByText(/Der Browser sperrt/).textContent).toContain('http://localhost');
	});
});
