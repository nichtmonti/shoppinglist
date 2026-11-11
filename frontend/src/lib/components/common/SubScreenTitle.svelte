<!--
  Names a list's sub-screen (previous items, the category editor, adding from
  text) in the list's app bar, which shows it as the screen's title with the
  list's name under it ([D-323]). Renders nothing itself. `meta` replaces the
  list's name while a mode needs the line (the category editor's arrange
  hint); `onback` is the screen's own step back, which the bar's ‹ takes
  ([D-304], the text import's review going back to its text, [D-254]);
  `action` is the screen's own bar action ([D-351]).
-->
<script lang="ts">
	import { subScreen } from './sub-screen.svelte.js';

	import type { Snippet } from 'svelte';
	let {
		title,
		meta,
		onback,
		action
	}: { title: string; meta?: string; onback?: () => void; action?: Snippet } = $props();

	$effect.pre(() => {
		subScreen.title = title;
		subScreen.meta = meta;
		subScreen.step = onback;
		subScreen.action = action;
		return () => {
			subScreen.title = undefined;
			subScreen.meta = undefined;
			subScreen.step = undefined;
			subScreen.action = undefined;
		};
	});
</script>
