<!--
  The shop view's "Erledigt (N)" section, also rendered by the dev gallery.
  A done item is its own row, faded, as "Frühere Artikel" shows one: the
  aisle's plate greyed, the name grey, the green tick at the end, ruled like
  the list. One look in every density, no strikethrough.
-->
<script lang="ts">
	import { displayName } from '#lib/item-name.js';
	import type { Item, ListCategory } from '#lib/db.js';
	import { categoryOf, categoryStyle } from '#lib/categories.js';
	import CategoryPlate from '#lib/components/common/CategoryPlate.svelte';
	import { t } from '#lib/i18n/index.js';
	import QuantityBadge from '#lib/components/common/QuantityBadge.svelte';
	import Check from '@lucide/svelte/icons/check';
	import { spokenName } from './tile-model';
	import SectionToggle from '#lib/components/common/SectionToggle.svelte';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import { cubicOut } from 'svelte/easing';
	import { dur, flipNear, ROW_FLIP_MS } from '#lib/state/motion.js';
	import { createTapGuard, tapPoint } from './tap-guard';

	interface Props {
		items: Item[];
		categories: ListCategory[];
		onrestore: (item: Item) => void | Promise<void>;
	}

	let { items, categories, onrestore }: Props = $props();
	// The rows slide up into a restored one's place, as the grid's tiles do
	// ([D-213], [D-293]).
	const acceptTap = createTapGuard();
	// Open by default, so a restore is one tap.
	let doneOpen = $state(true);

	// A restored row leaves this section with its focus: the next row gets it,
	// else the one before, else the section's head (WCAG 2.4.3), as a ticked
	// tile hands it on in ShopView. A tap moves it without scrolling.
	function restore(item: Item, event: MouseEvent): void {
		if (!acceptTap(tapPoint(event))) return;
		const button = event.currentTarget;
		if (button instanceof HTMLElement && document.activeElement === button) {
			const rows = [...(button.parentElement?.querySelectorAll<HTMLElement>('.done-row') ?? [])];
			const at = rows.indexOf(button);
			const head = button.closest('section')?.querySelector<HTMLElement>('.done-head');
			(rows[at + 1] ?? rows[at - 1] ?? head)?.focus({ preventScroll: event.detail > 0 });
		}
		void onrestore(item);
	}
</script>

{#if items.length > 0}
	<section class="mt-3">
		<SectionToggle
			class="done-head"
			data-testid="done-head"
			label={t('shop_done_section')}
			count={items.length}
			bind:open={doneOpen}
		>
			{#snippet content(props)}
				<RuledRows {...props} inset="var(--row-rule-inset)" class="done-list pb-2.5">
					{#each items as item (item.id)}
						{@const cat = categoryOf(item, categories)}
						<button
							type="button"
							animate:flipNear={{ duration: dur(ROW_FLIP_MS), easing: cubicOut }}
							class="done-row flex min-h-13 w-full items-center gap-3 px-(--row-gutter) py-2 text-muted-foreground press-row"
							data-testid="done-row"
							onclick={(event) => restore(item, event)}
							aria-label={t('shop_restore_tile', {
								name: spokenName([displayName(item), item.quantity])
							})}
						>
							<CategoryPlate
								icon={cat?.icon}
								size="item"
								class="grayscale-35 opacity-85"
								style={cat ? categoryStyle(cat.color) : undefined}
							/>
							<!-- Two lines: a done row has no door to read a cut name in full. -->
							<span
								class="min-w-0 flex-1 text-sm font-book line-clamp-2 wrap-anywhere hyphens-auto text-start"
								dir="auto">{displayName(item)}</span
							>
							<QuantityBadge quantity={item.quantity} variant="plain" />
							<Check
								class="dc size-5 shrink-0 text-primary-text"
								strokeWidth={2.4}
								aria-hidden="true"
							/>
						</button>
					{/each}
				</RuledRows>
			{/snippet}
		</SectionToggle>
	</section>
{/if}
