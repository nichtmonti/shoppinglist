// The browser harnesses' lint. Type-aware, because the bug that matters most
// here is a promise nobody awaits: an un-awaited `page.click()` or `expect()`
// lets the test run on (no-floating-promises, missing-playwright-await).
// Every rule kept is an error; a warning nobody reads is no check.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';

const recommended = playwright.configs['flat/recommended'];

export default tseslint.config(
	{ ignores: ['**/test-results/**', 'playwright-report/**'] },
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: {
			// Stand-ins for browser APIs return promises because the API does.
			'@typescript-eslint/require-await': 'off',
			// IndexedDB rejects with its own DOMException, handed on as it is.
			'@typescript-eslint/prefer-promise-reject-errors': 'off'
		}
	},
	{
		...recommended,
		rules: {
			...Object.fromEntries(
				Object.entries(recommended.rules).map(([rule, level]) => [
					rule,
					level === 'off' ? 'off' : 'error'
				])
			),
			// A harness walks routes, locales and a diagnostics switch in loops;
			// the rule cannot tell that from a test that branches on its result.
			'playwright/no-conditional-in-test': 'off',
			'playwright/no-conditional-expect': 'off',
			// shots/ skips what a run did not ask for, and says so.
			'playwright/no-skipped-test': ['error', { allowConditional: true }],
			// Layout is prettier's.
			'playwright/consistent-spacing-between-blocks': 'off'
		}
	},
	{
		// The walk's settle loops and the screenshots' pacing are timed by
		// design; a spec's own sleep names its reason where it stands.
		files: ['arch/walk.ts', 'shots/**'],
		rules: { 'playwright/no-wait-for-timeout': 'off' }
	},
	{ files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked }
);
