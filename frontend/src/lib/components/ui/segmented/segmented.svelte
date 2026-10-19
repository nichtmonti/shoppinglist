<!--
  The app's segmented control (band, tabs and chips variants), built on bits-ui's
  ToggleGroup.

  ToggleGroup, not Tabs: this is a single-choice picker, and the e2e specs
  assert the `role="radio"` + `aria-checked` it emits.

  ToggleGroup lets the active item be deselected (value ''). The value is a
  function binding: the getter reads the caller's `value`, the
  setter drops the ''. A one-way `{value}` would not do: bits-ui would already
  have moved its own state to '', leaving no segment selected.
-->
<script lang="ts" generics="T extends string">
	import { ToggleGroup } from 'bits-ui';
	import { cn, tv } from '#lib/utils.js';
	import type { Component } from 'svelte';

	interface Option {
		value: T;
		label: string;
		icon?: Component;
	}

	let {
		value,
		options,
		onchange,
		label,
		testid,
		variant = 'chips',
		class: klass
	}: {
		value: T;
		options: Option[];
		onchange: (value: T) => void;
		label: string; // aria-label for the group
		testid?: string; // base testid; item i gets `${testid}-${options[i].value}`
		variant?: 'band' | 'tabs' | 'chips';
		class?: string;
	} = $props();

	const root = tv({
		variants: {
			variant: {
				band: 'grid h-11 gap-1 rounded-control border border-border bg-background p-1',
				// The list's view switch on the app bar's foot ([D-276]): a rule
				// above sets it off from the title row, and the chosen tab's line
				// sits on the bar's own bottom border.
				tabs: 'grid h-11 border-t border-border px-4',
				chips: 'flex flex-wrap gap-2'
			}
		}
	});

	const item = tv({
		base: 'font-demi text-muted-foreground cursor-pointer data-[state=off]:hover:text-foreground',
		variants: {
			variant: {
				// The chosen side is a state, so it takes the synced chip's soft
				// green, not the solid fill of a primary action, which out-shouted
				// the list's name ([D-276]). Hover leaves the green to that state.
				band:
					'flex items-center justify-center gap-1.5 rounded-chip border border-transparent ' +
					'px-2 text-sm data-[state=off]:hover:bg-tint ' +
					'data-[state=on]:border-primary-line data-[state=on]:bg-primary-soft ' +
					'data-[state=on]:text-primary-text',
				tabs: "relative flex items-center justify-center gap-1.5 px-2 text-sm after:absolute after:inset-x-2 after:-bottom-px after:h-[2.5px] after:rounded-t-full after:content-[''] data-[state=on]:text-foreground data-[state=on]:after:bg-primary-text data-[state=on]:[&>svg]:text-primary-text",
				chips:
					// A chosen option, like the band's: soft green, never the primary
					// action's solid fill ([D-281]).
					"relative inline-flex h-9 items-center rounded-full border border-border bg-surface-2 px-3.5 text-meta after:absolute after:inset-[-4px] after:content-[''] " +
					'data-[state=off]:hover:border-line-strong data-[state=off]:hover:bg-tint ' +
					'data-[state=on]:border-primary-line data-[state=on]:bg-primary-soft ' +
					'data-[state=on]:text-primary-text'
			}
		}
	});

	// Drops a deselect (see the header).
	function handleValueChange(v: string) {
		// svelte-check needs the cast (string is not T); the lint rule misses
		// the generic and flags it.
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		if (v) onchange(v as T);
	}
</script>

<ToggleGroup.Root
	type="single"
	bind:value={() => value, handleValueChange}
	aria-label={label}
	data-testid={testid}
	class={cn(root({ variant }), klass)}
	style={variant !== 'chips'
		? `grid-template-columns: repeat(${options.length}, minmax(0, 1fr))`
		: undefined}
>
	{#each options as o (o.value)}
		<ToggleGroup.Item
			value={o.value}
			class={item({ variant })}
			data-testid={testid ? `${testid}-${o.value}` : undefined}
		>
			{#if o.icon}<o.icon class="size-4 block shrink-0" />{/if}
			{o.label}
		</ToggleGroup.Item>
	{/each}
</ToggleGroup.Root>
