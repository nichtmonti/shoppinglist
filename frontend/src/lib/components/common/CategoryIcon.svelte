<!--
  One category icon, wherever a category shows its emoji ([D-180]). The chip
  stays with the caller; this is the picture inside it, sized from `chip` at
  one ratio, so every icon fills its chip alike and follows the text size.
  The picture is Emoji, the bundled OpenMoji artwork ([D-181]).
-->
<script lang="ts" module>
	/** What the glyph's em is, as a share of its chip's size. */
	export const GLYPH_RATIO = 0.75;
	/** The icon of a category that has none (and of a row without a category). */
	export const FALLBACK_ICON = '📦';
</script>

<script lang="ts">
	import Emoji from './Emoji.svelte';

	interface Props {
		icon: string | null | undefined;
		/** The chip's size in rem (Tailwind size-6.5 → 1.625). */
		chip: number;
	}

	let { icon, chip }: Props = $props();
</script>

<Emoji emoji={icon || FALLBACK_ICON} size={chip * GLYPH_RATIO} />
