// The one `#lib/toasts.js` mock: the real module with its toasts as spies.
// By default they show nothing; `{ show: true }` lets them through to Sonner,
// for a test that reads the toast off the page. Everything else, the timeout
// included, is the real export, so a mock cannot drift from it.
//
//	vi.mock('#lib/toasts.js', async () =>
//		(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({ showToast })
//	);
import { vi } from 'vitest';

type Toasts = typeof import('#lib/toasts.js');

export async function toastsModuleMock(
	overrides: Partial<Toasts> = {},
	{ show = false }: { show?: boolean } = {}
): Promise<Toasts> {
	const actual = await vi.importActual<Toasts>('#lib/toasts.js');
	return {
		...actual,
		showToast: show ? vi.fn(actual.showToast) : vi.fn(),
		showFailure: show ? vi.fn(actual.showFailure) : vi.fn(),
		showNotice: show ? vi.fn(actual.showNotice) : vi.fn(),
		...overrides
	};
}
