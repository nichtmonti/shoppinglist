// The Paraglide options, read by both the CLI (`pnpm paraglide:compile`) and
// the Vite plugin. Tracked with `git add -f`: inlang writes a .gitignore here
// that ignores everything but settings.json. Since Paraglide 3 the plugin
// also writes a compile cache into ./cache/ — ignored in ../.gitignore,
// because a fresh checkout has no inlang .gitignore yet.
// Strategy: no cookie/URL locale routing — this is a client-only SPA with its
// own `meta.locale` persistence (§12), so `globalVariable` is the only strategy
// that applies; `getLocale()`/`setLocale()` are driven entirely by #lib/i18n.
//
// `outputStructure` is pinned because the plugin's default depends on the
// mode — locale-modules under dev and vitest, message-modules under
// `vite build` — and every one of them writes the same src/lib/paraglide, so
// whoever ran last would decide its layout and restructure the files a running
// dev server imports ([D-157]). message-modules is what production ships.
/** @type {import('@inlang/paraglide-js').ParaglideConfig} */
export default {
	outdir: './src/lib/paraglide',
	strategy: ['globalVariable', 'baseLocale'],
	emitTsDeclarations: true,
	outputStructure: 'message-modules'
};
