// Emoji drawn as OpenMoji artwork ([D-181]). The set is src/lib/emoji-set.json;
// vite-plugin-openmoji.ts turns it into `virtual:openmoji`.
import urls from 'virtual:openmoji';

import { openmojiStems } from './emoji-stems';

/** The OpenMoji artwork's URL for an emoji, or null when there is none (the
 *  caller then shows it as text). */
export function emojiAsset(emoji: string | null | undefined): string | null {
	if (!emoji) return null;
	for (const stem of openmojiStems(emoji)) {
		const url = urls[stem];
		if (url) return url;
	}
	return null;
}
