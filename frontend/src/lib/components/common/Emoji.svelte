<!--
  One emoji drawn as a picture ([D-181]): the bundled OpenMoji artwork, else
  the platform's emoji as text. Centred in a 1em box, content and items both,
  because an emoji's advance is ~1.25em ([D-180]). The picture is 1em
  itself, not 100%: centring the content sizes the grid's track by its
  content, and Firefox resolves a percentage of that track to 0. Decorative:
  the user names the thing.
-->
<script lang="ts">
	import { emojiAsset } from '#lib/emoji.js';

	interface Props {
		emoji: string;
		/** The picture's size in rem. */
		size: number;
	}

	let { emoji, size }: Props = $props();
	let src = $derived(emojiAsset(emoji));
</script>

<span
	class="emoji inline-grid size-[1em] place-content-center place-items-center text-(length:--emoji) leading-none"
	style="--emoji: {size.toFixed(4)}rem"
	aria-hidden="true"
	>{#if src}<img class="size-[1em]" {src} alt="" draggable="false" />{:else}{emoji}{/if}</span
>
