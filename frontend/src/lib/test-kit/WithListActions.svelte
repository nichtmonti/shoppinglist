<!--
  A component a list route renders, mounted alone with the route's
  ListActions in context and its dialogs beside it, as the list layout
  provides them.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import { online } from '#lib/state/online.js';
	import ListDialogs from '#lib/components/list/ListDialogs.svelte';
	import { ListActions, setListActions } from '#lib/components/list/list-actions.svelte.js';

	let { component, props }: { component: Component<never>; props: Record<string, unknown> } =
		$props();
	// Matching the props to the component is the test's job.
	let Child = $derived(component as unknown as Component<Record<string, unknown>>);

	const actions = setListActions(new ListActions(() => $online));
</script>

<Child {...props} />
<ListDialogs {actions} />
