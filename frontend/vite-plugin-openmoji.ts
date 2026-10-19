// Serves `virtual:openmoji` ([D-181]): a module whose default export maps
// OpenMoji file stems to asset URLs, for exactly the emoji in
// src/lib/emoji-set.json — imported straight from the pinned `openmoji` dev
// dependency, so only those few SVGs are ever emitted (the package holds
// ~4,500), and updating OpenMoji is a Renovate PR like any other dependency.
//
// Missing artwork fails the build (and the dev server, and vitest) with the
// emoji named: an OpenMoji release that renamed or dropped an icon the app
// uses must stop a PR, not quietly fall back to the platform's emoji.
//
// `?inline`: every icon is a data: URL inside the JS ([D-186]), so it is there
// the moment its row renders. As files (`?no-inline`, [D-181]) each `<img>`
// started loading only once drawn, and the icons popped in after the rows:
// on a first visit, on the dev server, and on every app start, since even a
// precached file goes through the service worker after the first paint. The
// whole set costs ~40 KB gzipped on the boot path, ~15 KB more than as files.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { VitestPluginContext } from 'vitest/node';

import { openmojiStems } from './src/lib/emoji-stems.ts';

const VIRTUAL = 'virtual:openmoji';
const RESOLVED = '\0' + VIRTUAL;

export function openmoji(): Plugin & {
	configureVitest?: (context: VitestPluginContext) => void;
} {
	const setFile = path.resolve(import.meta.dirname, 'src/lib/emoji-set.json');
	const pkgDir = path.dirname(createRequire(import.meta.url).resolve('openmoji/package.json'));
	const svgDir = path.join(pkgDir, 'color/svg');
	return {
		name: 'openmoji',
		// Vitest's module cache (fsModuleCache, vite.config.ts) keys a module by
		// its file; this one has none, and its code follows emoji-set.json and
		// the installed OpenMoji. Both go into its key, so a cached copy never
		// outlives either.
		configureVitest({ defineCacheKeyGenerator }) {
			defineCacheKeyGenerator(({ id }) => {
				if (id !== RESOLVED) return undefined;
				const version = (
					JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
						version: string;
					}
				).version;
				const set = createHash('sha256').update(readFileSync(setFile)).digest('hex');
				return `openmoji:${version}:${set}`;
			});
		},
		resolveId(id) {
			return id === VIRTUAL ? RESOLVED : undefined;
		},
		load(id) {
			if (id !== RESOLVED) return;
			this.addWatchFile(setFile);
			const set = JSON.parse(readFileSync(setFile, 'utf8')) as { pick: string[]; decor: string[] };
			const stems = new Set<string>();
			const missing: string[] = [];
			for (const emoji of [...set.pick, ...set.decor]) {
				const stem = openmojiStems(emoji).find((s) => existsSync(path.join(svgDir, `${s}.svg`)));
				if (stem) stems.add(stem);
				else missing.push(emoji);
			}
			if (missing.length) {
				const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
				this.error(
					`OpenMoji ${version} has no artwork for ${missing.join(' ')} (src/lib/emoji-set.json)`
				);
			}
			const list = [...stems];
			return (
				list
					.map(
						(s, i) =>
							`import u${i} from ${JSON.stringify(path.join(svgDir, `${s}.svg`) + '?inline')};`
					)
					.join('\n') +
				`\nexport default { ${list.map((s, i) => `${JSON.stringify(s)}: u${i}`).join(', ')} };\n`
			);
		}
	};
}
