// The FULL lint config — what CI (pnpm lint) and the gate's lint task run (on
// the changed files; the whole project with --cold/--all). The shared base lives in eslint.shared.config.js; this
// file adds the type-aware layer on top. Iteration runs use the fast tier:
// eslint.syntactic.config.js (same base, no type-aware layer, --cache-safe).
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import path from 'node:path';
import ts from 'typescript-eslint';
import { sharedBase, sharedRest } from './eslint.shared.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	...sharedBase(),
	// Type-aware linting (not just `recommended`) so the rules that need the type
	// checker are active — above all no-floating-promises / no-misused-promises,
	// the failure mode that matters most in the §8 sync engine, where a dropped
	// await silently skips a drain or a settle. The `no-unsafe-*` family is turned
	// off below; see the rationale there.
	ts.configs.recommendedTypeChecked,
	...sharedRest(),
	{
		languageOptions: {
			// Type-aware rules need a program; projectService picks up tsconfig.json.
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: {
			// The `no-unsafe-*` family is OFF by choice. Dexie's per-table generics make
			// `db[collection]` a union no narrowing accepts; db.ts confines the one
			// unavoidable cast to syncTable/shadowTable (`as unknown as Table<…>`), and the
			// values that flow out of it would otherwise trip these rules as noise that
			// trains the reader to ignore lint output. `no-explicit-any`
			// stays ON, so introducing a NEW `any` is still a conscious, annotated act.
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-return': 'off'
		}
	},
	{
		// Plain-JS config files (this one and its eslint.*.config.js siblings) are outside tsconfig's
		// program, so type-aware rules cannot run on them.
		files: ['**/*.js'],
		extends: [ts.configs.disableTypeChecked]
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	}
);
