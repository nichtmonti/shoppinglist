// The settings row that offers installing the app ([D-231]): the browser's own
// dialog where Chromium offers one, the steps everywhere else, nothing once the
// app runs from the home screen.
import { render, screen, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '#lib/i18n/index.js';
import { install, listenForInstall } from '#lib/install.svelte.js';
import { installEvent } from '#lib/test-kit/install.js';
import InstallGroup from './InstallGroup.svelte';

const IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID =
	'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

let stop: () => void;

/** The row is the button; its name is its label and its line. */
const installRow = () =>
	screen.getByRole('button', { name: new RegExp(`^${t('settings_install_title')}`) });

beforeEach(() => {
	stop = listenForInstall();
});

afterEach(() => {
	stop();
	vi.restoreAllMocks();
	Object.assign(install, { deferred: null, installed: false });
});

describe('InstallGroup', () => {
	it('opens the browser’s install dialog when it has offered one', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
		const event = installEvent();
		window.dispatchEvent(event);
		render(InstallGroup);

		await fireEvent.click(installRow());

		expect(event.prompted).toBe(1);
		expect(screen.queryByTestId('install-steps')).toBeNull();
	});

	it('shows the share-sheet steps on an iPhone', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
		render(InstallGroup);

		await fireEvent.click(installRow());

		const steps = await screen.findByTestId('install-steps');
		expect(steps.dataset.platform).toBe('ios');
		expect(steps.textContent).toContain(t('install_ios_2'));
		expect(screen.getByText(t('install_ios_signin'))).toBeDefined();
		expect(screen.getByText(t('install_fallback_ios'))).toBeDefined();
	});

	it('shows the menu steps where the browser has not offered installing', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
		render(InstallGroup);

		await fireEvent.click(installRow());

		const steps = await screen.findByTestId('install-steps');
		expect(steps.dataset.platform).toBe('android');
		expect(screen.queryByText(t('install_ios_signin'))).toBeNull();
	});

	it('says so once installed from this tab', async () => {
		render(InstallGroup);
		window.dispatchEvent(new Event('appinstalled'));
		expect(await screen.findByText(t('settings_install_done'))).toBeDefined();
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('is not there when the app runs from the home screen', () => {
		// iOS Safari's flag, the one the media query cannot stand in for.
		Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
		try {
			render(InstallGroup);
			expect(screen.queryByText(t('settings_install_title'))).toBeNull();
		} finally {
			Reflect.deleteProperty(navigator, 'standalone');
		}
	});
});
