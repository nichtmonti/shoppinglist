// The active locale as a rune ([D-291]): `t()` and `getLocale()` read it, so
// every string and `Intl` format rendered from them follows a language switch
// in place, and no screen is remounted for it.
import { getLocale as paraglideGetLocale } from '#lib/paraglide/runtime.js';
import type { Locale } from './index';

let current = $state<Locale>(paraglideGetLocale());

export const activeLocale = {
	get value(): Locale {
		return current;
	},
	set value(locale: Locale) {
		current = locale;
	}
};
