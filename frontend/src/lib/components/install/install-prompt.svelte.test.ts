// The browser fires `beforeinstallprompt` once per page load, and the app shell
// remounts this component on every language change ({#key $localePref} in
// +layout.svelte) — the captured event lives in #lib/install, caught at boot,
// and has to outlive the instance.
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from '#lib/test-kit/db.js';
import { t } from '#lib/i18n/index.js';
import { install, listenForInstall } from '#lib/install.svelte.js';
import { installEvent } from '#lib/test-kit/install.js';
import InstallPrompt from './InstallPrompt.svelte';

let stop: () => void;

beforeEach(async () => {
	await resetDb();
	stop = listenForInstall();
});

afterEach(() => {
	stop();
	install.deferred = null;
});

describe('InstallPrompt', () => {
	it('still offers the install after a remount', async () => {
		const first = render(InstallPrompt);
		window.dispatchEvent(installEvent());
		expect(await screen.findByText(t('install_title'))).toBeDefined();

		first.unmount();
		render(InstallPrompt);

		expect(await screen.findByText(t('install_title'))).toBeDefined();
	});

	it('offers an install caught before it mounted', async () => {
		window.dispatchEvent(installEvent());
		render(InstallPrompt);
		expect(await screen.findByText(t('install_title'))).toBeDefined();
	});
});
