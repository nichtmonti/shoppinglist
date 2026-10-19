<!--
  §9 / §9.1 — the add field's dropdown: the ranked suggestions, each with its
  aisle, "last bought" date and a ✕ that suppresses the name (§6.11), and the
  as-typed add at the foot, drawn as one of them. Rendered inside AddBar's
  Combobox.Root; AddBar owns the gestures and what a pick commits.
-->
<script lang="ts">
	import { floatSurface } from '#lib/components/ui/card/card-surface.js';
	import CategoryPlate from '#lib/components/common/CategoryPlate.svelte';
	import { categoryStyle } from '#lib/categories.js';
	import { t } from '#lib/i18n/index.js';
	import X from '@lucide/svelte/icons/x';
	import QuantityBadge from '#lib/components/common/QuantityBadge.svelte';
	import { Combobox } from 'bits-ui';
	import type { Suggestion } from './add-model';

	interface Props {
		/** The suggestions, then the as-typed add (`withTypedCandidate`). */
		candidates: Suggestion[];
		/** The amount typed with the name ([D-285]); '' for none. */
		quantity: string;
		/** [D-132] AddBar's touch path: pointerup claims the tap, click commits it. */
		onitempointerup: (event: PointerEvent, value: string) => void;
		onitemclick: (value: string) => void;
		onsuppress: (name: string) => void;
	}

	let { candidates, quantity, onitempointerup, onitemclick, onsuppress }: Props = $props();

	// A row of the page's rhythm, ruled as every list is ([D-326]).
	const ROW =
		'relative flex w-full min-w-0 items-start gap-3 px-(--row-gutter) py-2.5 press-row data-highlighted:bg-primary-soft option-bar';
</script>

<Combobox.ContentStatic
	aria-label={t('add_label')}
	class={[
		floatSurface,
		'ta-drop ruled-rows absolute inset-x-3.5 top-(--addbar-h) z-3 overflow-hidden'
	]}
	style="--rule-inset: var(--plate-rule-inset)"
>
	{#each candidates as c (c.key)}
		<!-- Aisle first, then the date. The line wraps rather than truncates:
		     the row is variable-height anyway, so it needs no cut-order ladder
		     like the shop tile's ([D-83]). -->
		{@const meta = [c.categoryLabel, c.when].filter(Boolean).join(' · ')}
		<Combobox.Item
			value={c.key}
			label={c.name}
			onpointerup={(event) => onitempointerup(event, c.key)}
			onclick={() => onitemclick(c.key)}
			class={[ROW, c.typed && 'ta-add']}
			data-ta-name={c.typed ? undefined : c.name}
			data-ta-add={c.typed ? c.name : undefined}
			style={categoryStyle(c.color)}
		>
			<CategoryPlate icon={c.icon} class="mt-0.5" />
			<span class="flex min-w-0 flex-1 flex-col gap-0.5">
				<span class="ta-name text-sm font-book wrap-break-word whitespace-normal" dir="auto"
					><span class="match font-bold">{c.name.slice(0, c.matchLength)}</span>{c.name.slice(
						c.matchLength
					)}</span
				>
				{#if meta}
					<span class="ta-cat text-micro text-muted-foreground">{meta}</span>
				{/if}
			</span>
			<!-- [D-285] The typed amount on every candidate, so the split shows
			     before a pick: the shop chip's grey, since the amount is what the
			     item will show ([D-332]). -->
			<QuantityBadge {quantity} class="ta-qty max-w-(--qty-max) flex-none self-center truncate" />
			{#if c.typed}
				<!-- The ✕'s place, so the chip lines up with the ones above. -->
				<span class="w-7.5 flex-none" aria-hidden="true"></span>
			{:else}
				<!-- The ✕ is a span, not a button, inside the option; it stops
				     pointerup (bits-ui selects on pointerup) as well as click. -->
				<span
					class="ta-suppress relative size-7.5 flex-none self-start rounded-chip grid place-items-center text-muted-foreground cursor-pointer hit-target hover:bg-tint-strong hover:text-foreground"
					aria-hidden="true"
					title={t('add_suppress_short')}
					onpointerdown={(event) => event.stopPropagation()}
					onpointerup={(event) => event.stopPropagation()}
					onclick={(event) => {
						event.stopPropagation();
						onsuppress(c.name);
					}}
				>
					<X class="size-3.5 shrink-0" />
				</span>
			{/if}
		</Combobox.Item>
	{/each}
</Combobox.ContentStatic>
