<!--
  The app's sort control: an app-bar icon button whose glyph is the selected
  order, with a radio menu behind it, for ItemSort and the home's list order
  (§9.3). Callers own the options and the preference. `action` is an optional
  command under the choices, such as the home's "Reihenfolge ändern …"
  ([D-90]).
-->
<script lang="ts" generics="T extends string">
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import type { Component } from 'svelte';

	interface Option {
		value: T;
		label: string;
		icon: Component;
	}

	let {
		value,
		options,
		onselect,
		label,
		testid,
		action,
		group
	}: {
		value: T;
		options: Option[];
		onselect: (value: T) => void;
		label: string; // the control's own name — the selected label is appended
		testid: string;
		action?: { label: string; icon: Component; onselect: () => void };
		/** A second choice under the first: the shop grid's density beside
		 *  the item order ([D-271]). Then each choice gets its heading. */
		group?: {
			/** The first choice's heading. */
			heading: string;
			/** This one's heading and accessible name. */
			label: string;
			value: string;
			options: { value: string; label: string; icon: Component }[];
			onselect: (value: string) => void;
		};
	} = $props();

	let selected = $derived(options.find((option) => option.value === value) ?? options[0]);
	let triggerLabel = $derived(`${label}: ${selected.label}`);

	// The radio group reports a plain string; only an option's value is a choice.
	function choose(next: string): void {
		const option = options.find((o) => o.value === next);
		if (option) onselect(option.value);
	}
</script>

<!-- Seen, not read: each radio group carries its own name. -->
{#snippet heading(text: string)}
	<div class="px-3 pt-1.5 pb-1 type-caption" aria-hidden="true">
		{text}
	</div>
{/snippet}

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		aria-label={triggerLabel}
		data-testid={testid}
	>
		<selected.icon class="bar-icon size-5.5" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		{#if group}{@render heading(group.heading)}{/if}
		<DropdownMenu.RadioGroup {value} onValueChange={choose} aria-label={label}>
			{#each options as option (option.value)}
				<DropdownMenu.RadioItem value={option.value}>
					<option.icon />
					{option.label}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
		{#if group}
			<DropdownMenu.Separator />
			{@render heading(group.label)}
			<DropdownMenu.RadioGroup
				value={group.value}
				onValueChange={group.onselect}
				aria-label={group.label}
			>
				{#each group.options as option (option.value)}
					<DropdownMenu.RadioItem value={option.value}>
						<option.icon />
						{option.label}
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		{/if}
		{#if action}
			<DropdownMenu.Separator />
			<DropdownMenu.Item onSelect={action.onselect}>
				<action.icon />
				{action.label}
			</DropdownMenu.Item>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
