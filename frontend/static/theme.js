// The theme before the first paint. mode-watcher applies the stored choice
// only once the app's code has run, so a dark choice (or "system" on a dark
// phone) painted the light background first on every cold start. A file, not
// an inline script: the CSP allows the app's own origin and no inline code.
// Reads mode-watcher's own key and sets its own class, and points the
// browser bar at the choice as `#lib/theme-color.ts` does once the app runs:
// each theme-color meta keeps its shell colour in data-shell-color.
try {
	var mode = localStorage.getItem('mode-watcher-mode');
	var dark =
		mode === 'dark' ||
		(mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
	if (dark) document.documentElement.classList.add('dark');
	if (mode === 'light' || mode === 'dark') {
		var metas = document.querySelectorAll('meta[name="theme-color"][media]');
		var chosen = '';
		for (var i = 0; i < metas.length; i++) {
			var meta = metas[i];
			meta.dataset.shellColor = meta.dataset.shellColor || meta.getAttribute('content');
			if ((meta.getAttribute('media') || '').indexOf(mode) !== -1) chosen = meta.dataset.shellColor;
		}
		for (var j = 0; j < metas.length; j++) if (chosen) metas[j].setAttribute('content', chosen);
	}
} catch {
	// No storage (a private window): the app's own code decides, as before.
}
