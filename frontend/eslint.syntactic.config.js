// The FAST iteration lint tier (pnpm lint:fast, for editors and watch loops): everything
// eslint.config.js checks EXCEPT the type-aware layer
// (ts.configs.recommendedTypeChecked + projectService), which is ~5-10x the
// cost. Same shared base as the full config, so the two cannot drift apart;
// the typed tier is what the gate's lint task and CI run (pnpm lint points at
// eslint.config.js).
//
// Safe to --cache: typescript-eslint's caveat (the per-file cache cannot see
// cross-file type dependencies) applies only to typed rules, and this tier
// runs none of them.
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import path from 'node:path';
import ts from 'typescript-eslint';
import { sharedBase, sharedRest } from './eslint.shared.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	...sharedBase(),
	ts.configs.recommended,
	...sharedRest(),
	{
		// Typed-rule disables (e.g. @typescript-eslint/prefer-promise-reject-errors
		// in async-action.svelte.test.ts) are legitimately unused here: this tier
		// runs no type-aware rules. The full config reports them.
		linterOptions: { reportUnusedDisableDirectives: false }
	}
);
