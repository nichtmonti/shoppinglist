// OpenMoji's file stems for an emoji, most specific first ([D-181]): the code
// points in upper-case hex joined by '-', then the same without U+FE0F, which
// OpenMoji drops from single-character names (❄️ is 2744.svg) but keeps in
// sequences. Dependency-free, because the build plugin and #lib/emoji share it.
export function openmojiStems(emoji: string): string[] {
	const points = [...emoji].map((c) =>
		c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
	);
	const exact = points.join('-');
	const bare = points.filter((p) => p !== 'FE0F').join('-');
	return exact === bare ? [exact] : [exact, bare];
}
