<!--
  §9.1 one shop-view tile: the square grid card, or at the list density the
  full-width check-off row ([D-83], [D-313]). Pure presentation, shared with
  /dev/gallery; what it shows is tileModel()'s, and this file adds whether the
  text is cut.

  The card pattern ([D-83]): the check-off is a transparent button covering a
  plain box, so the ⓘ door (a button may not nest one) sits in the tile's own
  grid. A row's door is its lead instead, the photo's thumbnail or the
  category icon, marked by an ⓘ badge ([D-331]). All styling is
  shop-tile.css's, keyed on the data attributes. The text layers are
  aria-hidden: the check button's label carries them.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import type { Item } from '#lib/db.js';
	import QuantityBadge from '#lib/components/common/QuantityBadge.svelte';
	import CategoryIcon from '#lib/components/common/CategoryIcon.svelte';
	import { categoryStyle } from '#lib/categories.js';
	import Info from '@lucide/svelte/icons/info';
	import { showsDoor, spokenName, tileModel, type TileMark } from './tile-model';

	interface Props {
		item: Item;
		/** The list density's shape ([D-83], [D-313]). */
		row?: boolean;
		/** The row's category, shown first where no aisle header names it. */
		mark?: TileMark | null;
		/** The photo errored; the grid tile shows the placeholder. */
		photoFailed?: boolean;
		onphotoerror?: () => void;
		/** Gets the click, so the caller can tell where a finger landed. */
		oncheck?: (event: MouseEvent) => void;
		/** Opens the detail sheet; the door is its only trigger ([D-83]). */
		oninfo?: () => void;
		/** Changes when the line the name is measured against can have
		 *  changed: the shop's width, the text size, a font (ShopItems). */
		remeasure?: unknown;
	}

	let {
		item,
		row = false,
		mark = null,
		photoFailed = false,
		onphotoerror,
		oncheck,
		oninfo,
		remeasure
	}: Props = $props();

	let model = $derived(tileModel(item, { photoFailed, row }));

	// Truncation ([D-83]): whether the name's clamp or the note's or the
	// quantity's ellipsis cuts text, which decides the door ([D-83]); the
	// name's also decides its alignment. Row names are cut in width, grid
	// names in height.
	let tileEl = $state<HTMLElement | null>(null);
	let nameEl = $state<HTMLElement | null>(null);
	let noteEl = $state<HTMLElement | null>(null);
	let qtyEl = $state<HTMLElement | null>(null);
	let textEl = $state<HTMLElement | null>(null);
	// How far above the tile's foot the text starts, for the photo scrim
	// ([D-83]); null without a scrim. The lead covers the glyphs' shadow.
	let textTop = $state<string | null>(null);
	// Primitives, because `model` is a new object on every store emission and
	// only a change the tile can show should re-measure.
	let scrimmed = $derived(model.kind === 'product' && !row);
	let nameCut = $state(false);
	let noteCut = $state(false);
	let qtyCut = $state(false);

	let measuredContent = $derived(
		[model.kind, model.media, model.name, model.note, model.quantity, model.hidesDetails].join(
			'\u0000'
		)
	);

	$effect(() => {
		const name = nameEl;
		const note = noteEl;
		const qty = qtyEl;
		void remeasure;
		void row;
		void measuredContent;
		noteCut = note ? note.scrollWidth > note.clientWidth + 1 : false;
		qtyCut = qty ? qty.scrollWidth > qty.clientWidth + 1 : false;
		const tile = tileEl;
		const text = textEl;
		const top =
			scrimmed && tile && text
				? tile.getBoundingClientRect().bottom - text.getBoundingClientRect().top
				: 0;
		textTop = top > 0 ? `${Math.ceil(top) + 4}px` : null;
		nameCut = name
			? row
				? name.scrollWidth > name.clientWidth + 1
				: name.scrollHeight > name.clientHeight + 1
			: false;
	});

	let door = $derived(showsDoor(model, nameCut || noteCut || qtyCut));
</script>

{#snippet leadFace()}
	{#if model.media === 'thumb'}
		<img
			class="tile-thumb"
			src={item.image_url}
			alt=""
			loading="lazy"
			decoding="async"
			onerror={() => onphotoerror?.()}
		/>
	{:else if mark}
		<CategoryIcon icon={mark.icon} chip={2.125} />
	{/if}
{/snippet}

<div
	class="tile"
	class:photo={model.kind === 'product'}
	class:row
	data-testid="tile"
	data-shape={row ? 'row' : 'grid'}
	data-kind={model.kind}
	data-door={door ? '' : undefined}
	data-marked={mark ? '' : undefined}
	style={mark ? categoryStyle(mark.color) : undefined}
	bind:this={tileEl}
	style:--tile-text-top={textTop}
>
	{#if model.media === 'photo'}
		<img
			class="tile-media tile-photo"
			data-testid="tile-photo"
			src={item.image_url}
			alt=""
			loading="lazy"
			decoding="async"
			onerror={() => onphotoerror?.()}
		/>
	{:else if model.media === 'placeholder'}
		<!-- [D-83]: a scanned product without a picture keeps its layout on a
		     dark bed, with no glyph: the name sits where it would land ([D-213]). -->
		<span class="tile-media tile-photo-fallback" aria-hidden="true"></span>
	{/if}
	{#if model.kind === 'product' && !row}
		<span class="scrim" aria-hidden="true"></span>
	{/if}
	<button
		type="button"
		class="tile-check"
		onclick={(event) => oncheck?.(event)}
		aria-label={t('shop_check_tile', {
			name: spokenName([model.name, model.quantity, model.note, mark?.name])
		})}
	></button>
	<span class="tile-text" aria-hidden="true" bind:this={textEl}>
		<span class="tile-name" class:clamped={nameCut} bind:this={nameEl} dir="auto">{model.name}</span
		>
		{#if model.note}
			<span class="tile-meta">
				<span class="tile-note" bind:this={noteEl} dir="auto">{model.note}</span>
			</span>
		{/if}
	</span>
	<!-- The row has no scrim, so it takes the neutral chip. -->
	<QuantityBadge
		quantity={model.quantity}
		variant={row && mark
			? 'tile-category'
			: model.kind === 'product' && !row
				? 'tile-photo'
				: 'tile'}
		aria-hidden="true"
		bind:ref={qtyEl}
	/>
	{#if door && !row}
		<button
			type="button"
			class="tile-info"
			onclick={() => oninfo?.()}
			aria-label={t('shop_product_info', { name: model.name })}
		>
			<Info class="tile-info-icon" />
		</button>
	{:else if door}
		<!-- [D-331]: a row's door is its lead, so nothing comes and goes at
		     the end of the row; without a category the ⓘ itself leads. Placed
		     after the check, as the tile's door is, for the focus order. -->
		<button
			type="button"
			class="tile-lead"
			onclick={() => oninfo?.()}
			aria-label={t('shop_product_info', { name: model.name })}
		>
			{#if model.media === 'thumb' || mark}
				<span class="tile-cat">{@render leadFace()}</span>
				<span class="tile-badge" aria-hidden="true">i</span>
			{:else}
				<Info class="tile-info-icon" />
			{/if}
		</button>
	{:else if mark}
		<span class="tile-lead" aria-hidden="true"
			><span class="tile-cat">{@render leadFace()}</span></span
		>
	{/if}
</div>
