// The active locale as a rune ([D-291]), and Paraglide's own: its getLocale
// and setLocale are pointed here, so every message function, through t() or
// not, and every `Intl` format follows a language switch in place, and no
// screen is remounted for it. Imported for that effect by ./index.
import { baseLocale, overwriteGetLocale, overwriteSetLocale } from '#lib/paraglide/runtime.js';
import type { Locale } from './index';

let current = $state<Locale>(baseLocale);

overwriteGetLocale(() => current);
overwriteSetLocale((locale) => {
	current = locale;
});
