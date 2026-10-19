import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted((): { record: { id: string } | null } => ({
	record: { id: 'k3m9x2p7q4w8z1r' }
}));
vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({ authStore })
);

import { t } from '#lib/i18n/index.js';
import { DEFAULT_SOURCE_URL } from '#lib/config.js';
import AboutFooter from './AboutFooter.svelte';

describe('AboutFooter', () => {
	it('credits OpenMoji with its licence, as CC BY-SA requires ([D-181])', () => {
		render(AboutFooter);
		expect(screen.getByRole('link', { name: t('settings_about_emoji') }).getAttribute('href')).toBe(
			'https://openmoji.org'
		);
		expect(
			screen.getByRole('link', { name: t('settings_about_emoji_license') }).getAttribute('href')
		).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
	});

	it('says "development build" when no server stamped a version', () => {
		// happy-dom's document carries no shoppinglist-version meta — like a shell
		// served by Vite under scripts/dev.sh.
		render(AboutFooter);
		expect(screen.getByTestId('app-version').textContent?.trim()).toBe(t('settings_about_dev'));
	});

	it('credits Open Food Facts for the product data, under its ODbL', () => {
		render(AboutFooter);
		expect(
			screen.getByRole('link', { name: t('settings_about_product_data') }).getAttribute('href')
		).toBe('https://world.openfoodfacts.org');
		expect(screen.getByRole('link', { name: 'ODbL' }).getAttribute('href')).toBe(
			'https://opendatacommons.org/licenses/odbl/1.0/'
		);
	});

	it('links the source code, as the AGPL-3.0 requires ([D-211])', () => {
		render(AboutFooter);
		expect(
			screen.getByRole('link', { name: t('settings_about_source') }).getAttribute('href')
		).toBe(DEFAULT_SOURCE_URL);
	});

	// [D-262] Tells two accounts with the same nickname apart.
	it("shows the account's code", () => {
		render(AboutFooter);
		expect(screen.getByTestId('account-code').textContent).toBe(
			t('settings_about_account', { code: '6KNS' })
		);
	});

	it('shows no code without an account', () => {
		authStore.record = null;
		render(AboutFooter);
		expect(screen.queryByTestId('account-code')).toBeNull();
	});
});
