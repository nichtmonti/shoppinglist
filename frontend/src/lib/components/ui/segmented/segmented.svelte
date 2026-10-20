<!--
  The app's segmented control (band, tabs and chips variants), built on bits-ui's
  RadioGroup: a single choice that cannot be unset, with the radio pattern's
  keyboard (arrow keys move and select). The picker tiles use the same
  primitive ([D-333]); the e2e specs assert its `role="radio"` + `aria-checked`.
-->
<script lang="ts" generics="T extends string">
	import { RadioGroup } from 'bits-ui';
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
		base: 'font-demi text-muted-foreground cursor-pointer data-[state=unchecked]:hover:text-foreground',
		variants: {
			variant: {
				// The chosen side is a state, so it takes the synced chip's soft
				// green, not the solid fill of a primary action, which out-shouted
				// the list's name ([D-276]). Hover leaves the green to that state.
				band:
					'flex items-center justify-center gap-1.5 rounded-chip border border-transparent ' +
					'px-2 text-sm data-[state=unchecked]:hover:bg-tint ' +
					'data-[state=checked]:border-primary-line data-[state=checked]:bg-primary-soft ' +
					'data-[state=checked]:text-primary-text',
				tabs: "relative flex items-center justify-center gap-1.5 px-2 text-sm after:absolute after:inset-x-2 after:-bottom-px after:h-[2.5px] after:rounded-t-full after:content-[''] data-[state=checked]:text-foreground data-[state=checked]:after:bg-primary-text data-[state=checked]:[&>svg]:text-primary-text",
				chips:
					// A chosen option, like the band's: soft green, never the primary
					// action's solid fill ([D-281]).
					"relative inline-flex h-9 items-center rounded-full border border-border bg-surface-2 px-3.5 text-meta after:absolute after:inset-[-4px] after:content-[''] " +
					'data-[state=unchecked]:hover:border-line-strong data-[state=unchecked]:hover:bg-tint ' +
					'data-[state=checked]:border-primary-line data-[state=checked]:bg-primary-soft ' +
					'data-[state=checked]:text-primary-text'
			}
		}
	});

</script>

<RadioGroup.Root
	{value}
	onValueChange={(v) => onchange(v as T)}
	aria-label={label}
	data-testid={testid}
	class={cn(root({ variant }), klass)}
	style={variant !== 'chips'
		? `grid-template-columns: repeat(${options.length}, minmax(0, 1fr))`
		: undefined}
>
	{#each options as o (o.value)}
		<RadioGroup.Item
			value={o.value}
			class={item({ variant })}
			data-testid={testid ? `${testid}-${o.value}` : undefined}
		>
			{#if o.icon}<o.icon class="size-4 block shrink-0" />{/if}
			{o.label}
		</RadioGroup.Item>
	{/each}
</RadioGroup.Root>
