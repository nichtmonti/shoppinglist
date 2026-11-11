<!--
  The list app bar's sub-screen action slot, alone: a test that renders a
  sub-screen without the list layout renders this beside it to press the
  action the screen puts in the bar ([D-323], [D-351]).
-->
<script lang="ts">
	import { subScreen } from '#lib/components/common/sub-screen.svelte.js';
</script>

{#if subScreen.action}{@render subScreen.action()}{/if}
