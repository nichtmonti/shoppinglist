#!/usr/bin/env node
// The type-aware lint (eslint.config.js), in two ESLint processes instead of
// one: the Svelte components and rune modules (*.svelte, *.svelte.ts,
// *.svelte.js), then everything else. Same files, same config, same findings:
// each file is still checked against the whole TypeScript program, only the
// process boundary moves.
//
// Why: in one process, a component test (*.svelte.test.ts) costs more the more
// Svelte components that process has already linted. Measured on the 411
// files (2026-10): all 145 components alone 45 s, 8 component tests alone
// 11 s, the two together 99.5 s; the whole project as one `eslint .` 27 min,
// as these two groups 70 s. It grew with every component and every test,
// which is how the full lint went from 5 to 28 minutes in two weeks. A larger
// heap does not help (4 GB: 29 min); it is not memory ([D-243]).
//
//   node scripts/lint.js            the whole project (pnpm lint, CI)
//   node scripts/lint.js <files…>   just these, split the same way (the gate)
//
// Both groups always run, so one run reports every finding; the exit status
// is the worse of the two.
import { spawnSync } from 'node:child_process';

const SVELTE = /\.svelte(\.(ts|js))?$/;
const files = process.argv.slice(2);

const eslint = (args) =>
	spawnSync('npx', ['eslint', '--no-warn-ignored', ...args], { stdio: 'inherit' }).status ?? 1;

let groups;
if (files.length === 0) {
	groups = [
		[
			'--no-error-on-unmatched-pattern',
			'src/**/*.svelte',
			'src/**/*.svelte.ts',
			'src/**/*.svelte.js'
		],
		[
			'.',
			'--ignore-pattern',
			'**/*.svelte',
			'--ignore-pattern',
			'**/*.svelte.ts',
			'--ignore-pattern',
			'**/*.svelte.js'
		]
	];
} else {
	groups = [files.filter((f) => SVELTE.test(f)), files.filter((f) => !SVELTE.test(f))].filter(
		(group) => group.length > 0
	);
}

let status = 0;
for (const args of groups) status = Math.max(status, eslint(args));
process.exit(status);
