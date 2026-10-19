<!-- One pure previous-items row. PreviousItems owns filtering, ordering and
     grouping; this component owns the repeated item presentation and exposes
     re-adding as a callback so it stays usable without a database subscription. -->
<script lang="ts">
	import CategoryPlate from '#lib/components/common/CategoryPlate.svelte';
	import { displayName } from '#lib/item-name.js';
	import type { Item, ListCategory } from '#lib/db.js';
	import { categoryStyle } from '#lib/categories.js';
	import { t } from '#lib/i18n/index.js';
	import Plus from '@lucide/svelte/icons/plus';

	interface Props {
		item: Item;
		category: ListCategory | null;
		when: string | null;
		showCategory?: boolean;
		onreadd: (event: MouseEvent) => void;
	}

	let { item, category, when, showCategory = true, onreadd }: Props = $props();
	// [D-200] The note is shown (it comes back on a re-add from here); the
	// quantity is the last trip's and is not.
	let note = $derived(item.note?.trim() || null);
	const noteId = $props.id();
</script>

<button
	type="button"
	class="prev-item flex min-h-13 w-full items-center gap-3 px-(--row-gutter) py-2.5 press-row"
	data-testid="prev-item"
	aria-label={when === null
		? t('history_readd', { name: displayName(item) })
		: t('history_readd_when', { name: displayName(item), when })}
	aria-describedby={note ? noteId : undefined}
	onclick={onreadd}
>
	{#if showCategory}
		<!-- Greyed a little: what the list bought before, not what it holds. -->
		<CategoryPlate
			icon={category?.icon}
			size="item"
			class="grayscale-35 opacity-85"
			style={category ? categoryStyle(category.color) : undefined}
		/>
	{/if}
	<span class="flex min-w-0 flex-1 flex-col">
		<span class="pi-name min-w-0 text-sm font-book text-muted-foreground truncate" dir="auto"
			>{displayName(item)}</span
		>
		{#if note}
			<span
				id={noteId}
				class="pi-note min-w-0 text-note font-book text-muted-foreground truncate"
				dir="auto">{note}</span
			>
		{/if}
	</span>
	{#if when}
		<span class="pi-when shrink-0 text-micro/flush text-muted-foreground">{when}</span>
	{/if}
	<span
		class="grid size-7 shrink-0 place-items-center rounded-chip text-primary-text"
		aria-hidden="true"><Plus class="size-5" strokeWidth={2.5} /></span
	>
</button>
