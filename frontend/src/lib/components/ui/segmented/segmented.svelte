<!--
  The app's segmented control (band, tabs and chips variants): a single choice
  that cannot be unset, whose arrow keys move and choose. Built on bits-ui's
  RadioGroup, the picker tiles' primitive ([D-333]); given a `panel`, it
  switches panels and is bits-ui's Tabs instead (tablist, tab, tabpanel),
  drawn the same. `chosen:` and `unchosen:` (app.css) style either one.
-->
<script lang="ts" generics="T extends string">
	import { RadioGroup, Tabs } from 'bits-ui';
	import { cn, tv } from '#lib/utils.js';
	import type { Component, Snippet } from 'svelte';

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
		panel,
		class: klass
	}: {
		value: T;
		options: Option[];
		onchange: (value: T) => void;
		label: string; // aria-label for the group
		testid?: string; // base testid; item i gets `${testid}-${options[i].value}`
		variant?: 'band' | 'tabs' | 'chips';
		/** The panel for a value; given, the control is a tab list over it. */
		panel?: Snippet<[T]>;
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
		base: 'font-demi text-muted-foreground cursor-pointer unchosen:hover:text-foreground',
		variants: {
			variant: {
				// The chosen side is a state, so it takes the synced chip's soft
				// green, not the solid fill of a primary action, which out-shouted
				// the list's name ([D-276]). Hover leaves the green to that state.
				band:
					'flex items-center justify-center gap-1.5 rounded-chip border border-transparent ' +
					'px-2 text-sm unchosen:hover:bg-tint ' +
					'chosen:border-primary-line chosen:bg-primary-soft ' +
					'chosen:text-primary-text',
				tabs: "relative flex items-center justify-center gap-1.5 px-2 text-sm after:absolute after:inset-x-2 after:-bottom-px after:h-[2.5px] after:rounded-t-full after:content-[''] chosen:text-foreground chosen:after:bg-primary-text chosen:[&>svg]:text-primary-text",
				chips:
					// A chosen option, like the band's: soft green, never the primary
					// action's solid fill ([D-281]).
					"relative inline-flex h-9 items-center rounded-full border border-border bg-surface-2 px-3.5 text-meta after:absolute after:inset-[-4px] after:content-[''] " +
					'unchosen:hover:border-line-strong unchosen:hover:bg-tint ' +
					'chosen:border-primary-line chosen:bg-primary-soft ' +
					'chosen:text-primary-text'
			}
		}
	});

	// svelte-check needs the cast (string is not T); the lint rule misses the
	// generic and flags it.
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
	const choose = (v: string) => onchange(v as T);
</script>

{#snippet face(o: Option)}
	{#if o.icon}<o.icon class="size-4 block shrink-0" />{/if}
	{o.label}
{/snippet}

{#if panel}
	<!-- The root lays out nothing: the list and the panel sit in the caller's
	     flow, as the radio group alone does. -->
	<Tabs.Root {value} onValueChange={choose} class="contents">
		<Tabs.List
			aria-label={label}
			data-testid={testid}
			class={cn(root({ variant }), klass)}
			style={variant !== 'chips'
				? `grid-template-columns: repeat(${options.length}, minmax(0, 1fr))`
				: undefined}
		>
			{#each options as o (o.value)}
				<Tabs.Trigger
					value={o.value}
					class={item({ variant })}
					data-testid={testid ? `${testid}-${o.value}` : undefined}
				>
					{@render face(o)}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		<!-- One panel per tab, as each tab's aria-controls names one; only the
		     chosen one draws. -->
		{#each options as o (o.value)}
			<Tabs.Content value={o.value}>
				{#if o.value === value}{@render panel(o.value)}{/if}
			</Tabs.Content>
		{/each}
	</Tabs.Root>
{:else}
	<RadioGroup.Root
		{value}
		onValueChange={choose}
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
				{@render face(o)}
			</RadioGroup.Item>
		{/each}
	</RadioGroup.Root>
{/if}
