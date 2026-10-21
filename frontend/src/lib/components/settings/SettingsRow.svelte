<!--
  One row of a SettingsGroup ([D-269]): a name, an optional grey line under
  it, and at the end a value, a control, or the › of a row that opens
  something. With `onclick` the whole row is the button, named by its label
  and value and described by its grey line, so a name that ticks ("zuletzt
  benutzt vor 4 Sekunden") never renames it. The button is laid over the row
  and holds no text of its own, as the home's list card does: text inside a
  control must be part of its name (WCAG 2.5.3), and the grey line is not. With `control` it is a plain row
  whose control wraps under the name when it does not fit, and stays at the
  end ([D-214]).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { cn } from '#lib/utils.js';

	let {
		label,
		hint,
		value,
		onclick,
		opens = false,
		tone = 'default',
		disabled = false,
		icon,
		control,
		testid,
		valueTestid,
		flush = false
	}: (
		| {
				/** Makes the row a button. */
				onclick: () => void;
				/** Required of a button row: whether it opens something (a sheet,
				 *  a screen, a prompt, a confirmation), which ends it in ›, or acts
				 *  at once („Auf diesem Gerät abmelden“), which does not. */
				opens: boolean;
		  }
		| { onclick?: undefined; opens?: undefined }
	) & {
		label: string;
		hint?: string;
		/** The current value, at the end (the nickname, "keine"). */
		value?: string;
		/** `danger` the red of the one irreversible action ([D-214]). An add
		 *  row reads like any other, its green on the + ([D-332]). */
		tone?: 'default' | 'danger';
		disabled?: boolean;
		icon?: Snippet;
		/** Given the label's id, so a button in it can be described by the row. */
		control?: Snippet<[labelId: string]>;
		testid?: string;
		valueTestid?: string;
		/** Inside a sheet: the text lines up with the sheet's title, and the
		 *  row's hover reaches only the sheet's slack (RuledRows' inset). */
		flush?: boolean;
	} = $props();

	const id = $props.id();
	// 52px like every list row, with or without the grey line, so the rows of a
	// group stand at one height ([D-332]).
	const rowCls = $derived(
		cn(
			'flex min-h-13 w-full items-center gap-3 py-1.5 text-start',
			flush ? 'px-1.5' : 'px-(--row-gutter)'
		)
	);
</script>

<!-- `hidden`: under the button, which names itself from these ids, so a
     screen reader does not read the row twice. -->
{#snippet body(hidden: boolean)}
	{#if icon}<span
			class={cn(
				'flex shrink-0 [&_svg]:size-5',
				tone === 'danger' ? 'text-danger' : 'text-muted-foreground'
			)}
			aria-hidden={hidden || undefined}>{@render icon()}</span
		>{/if}
	<!-- Beside a control the name takes its own width, so the control wraps
	     under it only when the two do not fit; beside a value it keeps 9rem. -->
	<span
		class={cn('flex min-w-0 flex-col gap-0.5', control ? 'flex-[1_1_auto]' : 'flex-[1_1_9rem]')}
		aria-hidden={hidden || undefined}
	>
		<span
			id="{id}-label"
			dir="auto"
			class={cn(
				'text-sm font-book wrap-break-word hyphens-auto',
				tone === 'danger' && 'text-danger'
			)}>{label}</span
		>
		{#if hint}<span id="{id}-hint" class="text-micro text-muted-foreground">{hint}</span>{/if}
	</span>
	{#if value !== undefined}
		<span
			id="{id}-value"
			class="ms-auto min-w-0 max-w-1/2 text-end text-sm text-muted-foreground wrap-break-word"
			dir="auto"
			aria-hidden={hidden || undefined}
			data-testid={valueTestid}>{value}</span
		>
	{/if}
{/snippet}

{#if onclick}
	<div
		class={cn(
			rowCls,
			'relative press-row has-[button:disabled]:opacity-50 has-[button:disabled]:hover:bg-transparent has-[button:disabled]:active:bg-transparent'
		)}
	>
		<button
			type="button"
			class="absolute inset-0 cursor-pointer focus-visible:-outline-offset-2 disabled:cursor-not-allowed"
			{disabled}
			{onclick}
			aria-labelledby={value === undefined ? `${id}-label` : `${id}-label ${id}-value`}
			aria-describedby={hint ? `${id}-hint` : undefined}
			data-testid={testid}
		></button>
		{@render body(true)}
		{#if opens}
			<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
	</div>
{:else}
	<div class={cn(rowCls, control && 'flex-wrap gap-y-2')} data-testid={testid}>
		{@render body(false)}
		{#if control}<div class="ms-auto">{@render control(`${id}-label`)}</div>{/if}
	</div>
{/if}
