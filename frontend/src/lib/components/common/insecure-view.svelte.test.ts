// [D-335] Where the browser withholds what the app needs, the page says so
// and where to open it instead.
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import InsecureView from './InsecureView.svelte';

describe('InsecureView', () => {
	it('names the HTTPS way and the localhost address', () => {
		render(InsecureView);
		expect(screen.getByRole('alert').textContent).toMatch(/https:\/\//);
		expect(screen.getByText(/http:\/\/localhost/)).toBeDefined();
	});
});
