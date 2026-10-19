// The browser bar's colour (the `theme-color` metas in app.html). The shell
// carries one per phone scheme, so before any code runs the bar matches
// "System". A choice of light or dark gives both metas that colour, so the
// bar follows the app rather than the phone; mode-watcher's own option
// rewrites only the first meta and would keep its media query. Each meta
// keeps its shell colour in data-shell-color, which static/theme.js also
// writes when it applies a stored choice before the first paint.

type Choice = 'light' | 'dark' | 'system';

/** Points every theme-color meta at the colour `choice` paints. */
export function followThemeChoice(choice: Choice, root: ParentNode = document): void {
	const metas = [...root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]')];
	const schemeOf = (meta: HTMLMetaElement) =>
		(meta.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light';
	for (const meta of metas) {
		meta.dataset.shellColor ??= meta.getAttribute('content') ?? '';
	}
	const colorOf = (scheme: 'light' | 'dark') =>
		metas.find((m) => schemeOf(m) === scheme)?.dataset.shellColor ?? '';
	for (const meta of metas) {
		meta.setAttribute('content', colorOf(choice === 'system' ? schemeOf(meta) : choice));
	}
}
