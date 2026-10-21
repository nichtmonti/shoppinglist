import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { openmoji } from './vite-plugin-openmoji.ts';

// Cap vitest's worker count at half the available parallelism, never fewer
// than two. Vitest's default is "one worker per core", which saturates every
// core during the transform/import phase (the dominant cost of a cold run)
// and starves the editor alongside it. Tests are
// ~a third of a cold run's wall time, so halving the workers moves the total
// little while leaving headroom for the vitest main process and everything
// else the box runs. `availableParallelism()` is cgroup-aware, so under a
// container's --cpus cap it scales down on its own.
//
// Applied PER PROJECT below: vitest gives each project its own pool and the
// projects run concurrently — a single root-level value does not reach them.
const maxWorkers = Math.max(2, Math.floor(availableParallelism() / 2));

export default defineConfig(({ command, isPreview }) => {
	// The dev server generates into its own directory, so the gate can run
	// beside scripts/dev.sh ([D-157]). SvelteKit rewrites `generated/` in
	// every process that syncs (its write-if-changed cache is per process), and
	// `svelte-kit sync`, svelte-check, vitest and `vite build` all sync into
	// the default `.svelte-kit` — which, shared, would reload an open dev page
	// on every gate layer. `.svelte-kit` stays what tsconfig.json, the editor
	// and every other tool read; only the running dev server moves out. Vitest
	// also runs as `serve`, hence VITEST.
	const devServer = command === 'serve' && !isPreview && !process.env.VITEST;
	// A second dev server — the tile audit's (e2e/tiles, [D-166]) or the
	// gallery screenshots' (e2e/shots) — names
	// itself so it gets its own generated dir AND its own dependency cache:
	// sharing node_modules/.vite, its different config would make Vite
	// re-optimize the deps under the running scripts/dev.sh server.
	const devInstance = process.env.SHOPPINGLIST_DEV_INSTANCE ?? 'dev';

	// Vite's dev client (dist/client/client.mjs, waitForSuccessfulPing)
	// reconnects after a dev-server restart through a SharedWorker minted
	// from a blob: URL, so a hidden tab rechecks the server and reloads once
	// it is back. With worker-src 'self' the CSP SvelteKit also serves in dev
	// blocks exactly that worker — a console CSP violation, and worse, the
	// client has no fallback on that path, so the tab stops auto-reloading
	// after a `pnpm dev` restart in Chromium. 'blob:' is therefore added for
	// the DEV SERVER only; no app code ever creates a worker, and the BUILT
	// policy (the single source of truth the Go header layer mirrors) stays
	// byte-identical: worker-src 'self'.
	const workerSrc: Array<'self' | 'blob:'> = command === 'serve' ? ['self', 'blob:'] : ['self'];

	// The demo build ([D-234]): `task build-spa DEMO=1` sets this. `#demo` is the
	// one door to the demo's client code, and only this build opens it: the
	// package.json import resolves to src/lib/demo/on.ts under the `demo`
	// condition, which only this build adds, and to src/lib/demo/off.ts
	// everywhere else (TypeScript, Vitest, the normal build), so no demo code
	// reaches a normal bundle (`task build-spa` checks). Its output
	// goes to build-demo/, which the demo binary embeds, so the two SPAs never mix.
	const demoBuild = process.env.SHOPPINGLIST_DEMO_BUILD === '1';

	return {
		cacheDir: devServer && devInstance !== 'dev' ? `node_modules/.vite-${devInstance}` : undefined,
		// The dependency scan starts from every component too, beside the
		// routes SvelteKit names: it bundles a component's <script> alone, so
		// a loader only the markup calls is tree-shaken before its import() is
		// crawled, and a dependency found that late reloads the open page.
		optimizeDeps: { entries: ['src/lib/**/*.svelte'] },
		...(demoBuild
			? {
					resolve: { conditions: [...defaultClientConditions, 'demo'] },
					ssr: { resolve: { conditions: [...defaultServerConditions, 'demo'] } }
				}
			: {}),
		plugins: [
			openmoji(),
			// §12.2 i18n — the options are in project.inlang/paraglide.config.js.
			paraglideVitePlugin({ project: './project.inlang' }),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				// SPA: emitted as a single index.html shell, served as static files by
				// PocketBase (pb_public). Routing is client-side (offline-first app,
				// IndexedDB-backed — no SSR).
				adapter: adapter({
					fallback: 'index.html',
					...(demoBuild ? { pages: 'build-demo', assets: 'build-demo' } : {})
				}),

				// The dev server's own generated dir — see devServer above.
				outDir: devServer ? `.svelte-kit-${devInstance}` : '.svelte-kit',

				// The build's version, SvelteKit's clock in ms unless the release sets
				// SOURCE_DATE_EPOCH (reproducible-builds.org) to the commit's time, so
				// a rebuild of a tag is byte-identical. It names the shell cache, and
				// lib/shell-caches.ts orders those as numbers, hence ms either way.
				...(process.env.SOURCE_DATE_EPOCH
					? { version: { name: String(Number(process.env.SOURCE_DATE_EPOCH) * 1000) } }
					: {}),

				// §10 CSP. Sits alongside `adapter` rather than under a `kit` key:
				// options passed inline to sveltekit() ARE the kit config (see
				// core/config/index.js split_config — anything it does not recognise is
				// forwarded to vite-plugin-svelte and silently ignored).
				//
				// THIS IS THE SINGLE SOURCE OF TRUTH for the policy: the build is fully
				// prerendered (adapter-static), so SvelteKit writes it into index.html
				// as <meta http-equiv="content-security-policy"> carrying the sha256 of
				// its own inline bootstrap <script>. The Go side
				// (backend/internal/security) reads that exact string back out of
				// index.html at startup and mirrors it as a response header — it never
				// composes a policy of its own, because a browser enforces meta and
				// header INDEPENDENTLY and a hand-written `script-src 'self'` header
				// would block the very bootstrap the meta hash allows.
				//
				// `frame-ancestors` is deliberately absent: meta CSP cannot express it
				// and SvelteKit drops it from meta output. The Go header appends it
				// (that, plus covering non-document responses, is why it exists).
				csp: {
					mode: 'hash',
					directives: {
						'default-src': ['self'],
						// 'wasm-unsafe-eval': zxing instantiates WebAssembly for the
						// barcode decode (lib/scan/decode.ts). No eval/new Function
						// exists in the bundle, so the narrow WASM-only relaxation is
						// enough — 'unsafe-eval' is not needed.
						'script-src': ['self', 'wasm-unsafe-eval'],
						// The build emits only <link rel=stylesheet>; the sole runtime
						// <style> is mode-watcher's constant transition-disable shim (it
						// appends `* { transition: none !important; }` while applying a
						// theme change), allowlisted by its sha256 hash.
						'style-src': ['self', 'sha256-OWM7eqRFZQb+Ir51EYZz6GAUUG4Oy2fNwCWX0peasbE='],
						// Unavoidable, and much weaker than it looks: this permits style
						// ATTRIBUTES only, never <style> blocks or stylesheets.
						// app.html's `<div style="display: contents">` plus the runtime
						// `style=` bindings (categoryStyle tints, measured sizes) need
						// it, and style attributes cannot be hashed without
						// 'unsafe-hashes'.
						'style-src-attr': ['unsafe-inline'],
						// item.image_url, rendered in <img> by ShopTile, ProductPhoto (the
						// item and product sheets) and ScanButton. It is a synced field a
						// client writes; the push route takes only the photo route's own
						// path ([D-266]), and 'self' is the second wall against a list
						// member pointing every other member's browser at a host of
						// their choosing. Product photos qualify because the backend
						// stores them and serves them from this origin ([D-21]); no
						// third-party image host is reachable at all. data: is for
						// locally generated images (QR code, icons).
						'img-src': ['self', 'data:'],
						// Barcode lookups go through the same-origin authenticated proxy;
						// the browser must not contact OFF/OBF directly.
						'connect-src': ['self'],
						// Dev-only 'blob:' — see workerSrc above.
						'worker-src': workerSrc,
						'manifest-src': ['self'],
						'object-src': ['none'],
						// Blocks a <base> injection from repointing every relative
						// script URL at an attacker origin.
						'base-uri': ['none'],
						'form-action': ['self'],
						'frame-src': ['none']
					}
				}
			}),
			tailwindcss()
		],
		server: {
			// Bind an explicit IPv4 address. Vite's default host is the string
			// "localhost", which Node resolves to ::1 on a dual-stack box — and every
			// port forwarder in the normal dev path (VS Code's auto-forwarding, ssh -L)
			// dials 127.0.0.1 over IPv4, so an IPv6-only listener leaves the browser
			// hanging on a connection that never completes. The backend already binds
			// IPv4 explicitly (scripts/dev.sh's --http=127.0.0.1:8090).
			//
			// `HOST` is read because the address has to differ between the two ways
			// this repo is developed, and only the environment knows which is in play:
			//
			//   - on a plain host, loopback is right — the dev server should not be on
			//     the LAN by accident;
			//   - inside the devcontainer, loopback is UNREACHABLE. The bind is
			//     namespaced to the container, so a browser on the host connects to
			//     nothing no matter how the port is forwarded. It has to be 0.0.0.0
			//     (still IPv4, so the ::1 problem above stays fixed).
			//
			// .devcontainer/devcontainer.json sets `containerEnv.HOST=0.0.0.0` for
			// exactly this; Vite — unlike CRA or Next — never reads `HOST` on its
			// own, so this line honours it. `pnpm dev --host` still overrides both
			// (CLI beats config).
			host: process.env.HOST ?? '127.0.0.1',
			// With the dev server generating elsewhere, `.svelte-kit` (and the
			// build/ dir `vite build` writes) are outside its module graph — but
			// Vite still full-reloads the page on any changed .html under its root,
			// and both carry index.html. Unwatched, so a gate layer's rewrite of
			// them is invisible here ([D-157]).
			watch: devServer ? { ignored: ['**/.svelte-kit/**', '**/build/**'] } : undefined,
			// Dev: keep the browser on Vite's single origin (needed for passkeys —
			// WebAuthn ties a credential to the exact origin it was created on) and
			// forward API calls to PocketBase. Mirrors prod, where PocketBase serves
			// both from one origin (see src/lib/pb.ts).
			proxy: {
				'/api': { target: 'http://127.0.0.1:8090', changeOrigin: true }
			}
		},
		test: {
			expect: { requireAssertions: true },
			// Transformed modules are kept on disk (node_modules/.vitest-cache) and
			// reused by the next process: a full unit run went from 116 s to 101 s,
			// and a single heavy test file, where transforming is 71% of the work,
			// gains most ([D-177]). The key is each file's content, id and the
			// environment's config; vite-plugin-openmoji.ts keys its virtual module
			// itself. A reinstall clears it with node_modules.
			fsModuleCache: true,
			// Coverage runs only with --coverage (CI's frontend-test, [D-203]): a
			// report of what the unit and component tests reach, no threshold.
			// App code only: not the tests, their helpers, generated Paraglide
			// output, the integration project or the dev-only gallery. The total
			// prints with the run; the lcov file is diff-cover's input, its paths
			// from the repo root as git names them.
			coverage: {
				provider: 'v8',
				include: ['src/**/*.{ts,svelte}'],
				exclude: [
					'src/**/*.test.ts',
					'src/**/*.d.ts',
					'src/lib/paraglide/**',
					'src/lib/test-kit/**',
					'src/integration/**',
					'src/routes/dev/**'
				],
				reporter: [
					'text-summary',
					['lcovonly', { projectRoot: fileURLToPath(new URL('..', import.meta.url)) }]
				],
				reportsDirectory: 'coverage'
			},
			setupFiles: ['./src/lib/test-kit/setup.ts'],
			// `vitest --changed` (the gate) cannot trace a message edit to the tests
			// that render it, through generated Paraglide output, nor a change to
			// the backend files the app imports, outside this root: run them all.
			// Absolute patterns: vitest matches them against absolute paths without
			// picomatch's `dot` option, so a `**/` pattern never matches inside a
			// worktree under .claude/, vitest's own defaults included.
			forceRerunTriggers: [
				'package.json',
				'pnpm-lock.yaml',
				'vite.config.ts',
				'vite-plugin-*.ts',
				'scripts/*.js',
				'messages/*.json',
				'project.inlang/settings.json',
				'../backend/seed/*.json',
				'../backend/internal/fieldcontract/*.json',
				'../backend/internal/ui/*.json'
			].map((p) => fileURLToPath(new URL(p, import.meta.url))),
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						// Every vi.stubGlobal is undone before the next test.
						unstubGlobals: true,
						environment: 'node',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						// Worker cap — see the root comment on maxWorkers.
						maxWorkers,
						// The 5s default is too tight for the heavy sync suites under full
						// parallel load (push.test.ts's 501-op batch-drain tests land right
						// at the ceiling). Mirror the client project's 15s — see its comment.
						testTimeout: 15_000,
						// src/integration is a separate project: it boots the real backend
						// binary, so it must not run in the default unit sweep.
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/integration/**']
					}
				},
				{
					// Svelte component tests. Files are named *.svelte.test.ts and the
					// `server` project excludes exactly that pattern, so each test runs in
					// exactly one project.
					extends: './vite.config.ts',
					// Without the browser condition, `svelte` resolves to its server build and
					// mount() throws lifecycle_function_unavailable. Scoped to this project so
					// the node-side projects keep their normal resolution.
					resolve: { conditions: ['browser'] },
					test: {
						name: 'client',
						// Every vi.stubGlobal is undone before the next test.
						unstubGlobals: true,
						// happy-dom, not jsdom: the component suite runs about a
						// quarter faster, and caught every planted focus/keyboard/ARIA bug
						// the jsdom run did. It implements Web Animations, ResizeObserver
						// and a spy-able location, which jsdom made us stub.
						environment: 'happy-dom',
						include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						setupFiles: ['./src/lib/test-kit/setup.ts', './src/lib/test-kit/component-setup.ts'],
						// Worker cap — see the root comment on maxWorkers.
						maxWorkers,
						// happy-dom + Svelte 5 + Dexie liveQuery cold-start on the first test
						// per file is heavier than vitest's 5s default on a slow CI runner
						// (the integration project sets 60s for the same reason). This is a
						// ceiling, not a floor — passing tests still finish in their normal
						// time; it only stops vitest killing the first test before Dexie
						// hydrates.
						testTimeout: 15_000
					}
				},
				{
					extends: './vite.config.ts',
					test: {
						name: 'integration',
						// Every vi.stubGlobal is undone before the next test.
						unstubGlobals: true,
						environment: 'node',
						include: ['src/integration/**/*.test.ts'],
						globalSetup: ['./src/integration/global-setup.ts'],
						setupFiles: ['./src/lib/test-kit/setup.ts', './src/integration/setup.ts'],
						// Two clients share one backend and one fixed port; running files in
						// parallel would interleave server state across them.
						fileParallelism: false,
						// Real HTTP + a real PocketBase transaction per op is slower than
						// the unit default, and the first test also waits on the server boot.
						testTimeout: 60_000,
						hookTimeout: 120_000
					}
				}
			]
		}
	};
});
