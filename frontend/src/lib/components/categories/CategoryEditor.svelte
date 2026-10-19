<!--
  §6.7 [D-37] the per-list category editor: add / rename / reorder / hide. The
  add/edit form, with its emoji and color pickers, is CategoryFormSheet.

  Reordering is a mode, as on the home screen ([D-90]); the editing rows
  never drag. Others is not arranged: sortCategories puts it last whatever its
  sort_order. Mutations go through #lib/actions/categories.ts ([D-40]).
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { listCategories } from '#lib/state/data.js';
	import { templateLookup } from '#lib/state/template-lookup.js';
	import {
		OTHERS_SLUG,
		categoryStyle,
		categoryName,
		sortCategories,
		visibleCategories,
		templateDefaultName,
		missingTemplates
	} from '#lib/categories.js';
	import { t } from '#lib/i18n/index.js';
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import {
		addMissingCategories,
		hideCategory,
		persistReorder,
		restoreCategory
	} from '#lib/actions/categories.js';
	import { online } from '#lib/state/online.js';
	import { showToast } from '#lib/toasts.js';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { AsyncAction } from '#lib/state/async-action.svelte.js';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import CategoryPlate from '#lib/components/common/CategoryPlate.svelte';
	import SectionToggle from '#lib/components/common/SectionToggle.svelte';
	import SubScreenTitle from '#lib/components/common/SubScreenTitle.svelte';
	import Pencil from '@lucide/svelte/icons/pencil';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Lock from '@lucide/svelte/icons/lock';
	import Plus from '@lucide/svelte/icons/plus';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cardSurface } from '#lib/components/ui/card/card-surface.js';
	import { tick } from 'svelte';
	import { closeMode, modeOpen, openMode } from '#lib/history-layers.svelte.js';
	import { cubicOut } from 'svelte/easing';
	import { dur, DND_FLIP_MS, flipNear } from '#lib/state/motion.js';
	import ArrangeList from '#lib/components/common/ArrangeList.svelte';
	import ArrangeDone from '#lib/components/common/ArrangeDone.svelte';
	import CategoryFormSheet from './CategoryFormSheet.svelte';
	import type { CategoryFormTarget } from './category-form';

	interface Props {
		listId: string;
	}

	let { listId }: Props = $props();

	let categoriesStore = $derived(listCategories(listId));
	let categories = $derived($categoriesStore);
	let templatesMap = $derived($templateLookup);

	let visible = $derived(sortCategories(visibleCategories(categories), templatesMap));
	let hidden = $derived(
		categories.filter((c) => c.deleted_at !== null).sort((a, b) => a.sort_order - b.sort_order)
	);

	// The hidden section starts open.
	let hiddenOpen = $state(true);
	const hiddenListId = $props.id();

	// ---- arrange mode (§6.7, [D-90]) ----
	// A history entry, so back closes the mode rather than leaving the screen.
	let movable = $derived(visible.filter((c) => c.slug !== OTHERS_SLUG));
	let others = $derived(visible.find((c) => c.slug === OTHERS_SLUG));
	let arrangeOpen = $derived(modeOpen('arrange-categories') && movable.length > 1);
	let arrangeButton = $state<HTMLButtonElement | null>(null);

	// However the mode closed, focus returns to the button that leads back in.
	let wasOpen = false;
	$effect(() => {
		const open = arrangeOpen;
		if (open === wasOpen) return;
		wasOpen = open;
		if (!open) void tick().then(() => arrangeButton?.focus());
	});

	// ---- the template aisles the list lacks ([D-251]) ----
	// Only once the list's rows are read: before that every template looks missing.
	const categoriesLoaded = $derived(categoriesStore.loaded);
	let missing = $derived(
		$categoriesLoaded ? missingTemplates(templatesMap.values(), categories) : []
	);
	// A failure shows under the button it answers, which is still there ([D-325]).
	const missingAction = new AsyncAction();

	async function addMissing(): Promise<void> {
		const a = await missingAction.run(() => addMissingCategories(listId));
		if (a.ok) showToast(t('categories_missing_added', { count: a.value.length }));
	}

	// ---- add/edit form (CategoryFormSheet) ----
	let formTarget = $state<CategoryFormTarget | null>(null);
</script>

<SubScreenTitle
	title={arrangeOpen ? t('categories_arrange_title') : t('categories_edit')}
	meta={arrangeOpen ? t('arrange_hint') : undefined}
/>

{#if arrangeOpen}
	<RuledRows inset="var(--plate-rule-inset)">
		<ArrangeList
			rows={movable}
			idOf={(c) => c.id}
			labelOf={(c) => categoryName(c, templatesMap)}
			onreorder={(ids) => void persistReorder(movable, ids)}
			label={t('categories_list_label')}
			inset="var(--plate-rule-inset)"
		>
			{#snippet row(c)}
				<span class="flex items-center gap-3" style={categoryStyle(c.color)}>
					<CategoryPlate icon={c.icon} />
					<span class="min-w-0 flex-1 text-sm font-book wrap-break-word"
						>{categoryName(c, templatesMap)}</span
					>
				</span>
			{/snippet}
		</ArrangeList>
		{#if others}
			<!-- Fixed last, with no arrows: sortCategories would undo the move. -->
			<div
				class="arrange-fixed flex min-h-13 items-center gap-3 py-1 ps-(--row-gutter) pe-5.5 text-muted-foreground"
				style={categoryStyle(others.color)}
			>
				<CategoryPlate icon={others.icon} />
				<span class="min-w-0 flex-1 text-sm font-book">{categoryName(others, templatesMap)}</span>
				<Lock class="size-4 shrink-0" aria-hidden="true" />
				<span class="sr-only">{t('categories_others_last')}</span>
			</div>
		{/if}
	</RuledRows>
	<ArrangeDone class="mt-3" ondone={() => closeMode('arrange-categories')} />
{:else}
	<RuledRows inset="var(--plate-rule-inset)" class="catedit-list">
		{#each visible as category (category.id)}
			{@const isOthers = category.slug === OTHERS_SLUG}
			{@const label = categoryName(category, templatesMap)}
			{@const defaultLabel = category.name ? templateDefaultName(category, templatesMap) : ''}
			<div
				class="catedit-row flex min-h-13 items-center gap-3 px-(--row-gutter) py-2"
				data-category-id={category.id}
				style={categoryStyle(category.color)}
				animate:flipNear={{ duration: dur(DND_FLIP_MS), easing: cubicOut }}
			>
				<CategoryPlate icon={category.icon} />
				<span class="ce-name flex-1 min-w-0 text-sm font-book">
					<span class="ce-label">{label}</span>
					{#if defaultLabel}
						<div class="def text-micro text-muted-foreground mt-px">
							{t('categories_default_name', { name: defaultLabel })}
						</div>
					{/if}
				</span>
				<!-- Quiet icons, not two framed buttons per row ([D-282]): 21 aisles
				     drew 42 boxes. -->
				<Button
					variant="quiet"
					size="icon-sm"
					class="ce-edit"
					onclick={() => (formTarget = { kind: 'edit', id: category.id })}
					aria-label={t('categories_edit_named', { name: label })}
					><Pencil class="shrink-0" /></Button
				>
				{#if isOthers}
					<span
						class="ce-locked size-7.5 flex-none grid place-items-center text-faint"
						aria-hidden="true"
						title={t('categories_others_locked')}><Lock class="size-4 shrink-0" /></span
					>
				{:else}
					<Button
						variant="quiet"
						size="icon-sm"
						class="ce-hide"
						onclick={() => void hideCategory(category, label)}
						aria-label={t('categories_hide_named', { name: label })}
						><EyeOff class="shrink-0" /></Button
					>
				{/if}
			</div>
		{/each}
		<!-- The list's last row adds to it, as „Passkey hinzufügen“ does: a row
		     with the green + in the plates' column, not a button below ([D-332]). -->
		<SettingsRow
			label={t('categories_add')}
			testid="ce-add"
			opens
			onclick={() => (formTarget = { kind: 'add' })}
		>
			{#snippet icon()}<span class="grid size-8.5 place-items-center"
					><Plus class="text-primary-text" aria-hidden="true" /></span
				>{/snippet}
		</SettingsRow>
	</RuledRows>

	{#if hidden.length > 0}
		<section class="border-t border-border">
			<SectionToggle
				label={t('categories_hidden_section')}
				count={hidden.length}
				bind:open={hiddenOpen}
				controls={hiddenListId}
			/>
			<RuledRows id={hiddenListId} inset="var(--plate-rule-inset)" hidden={!hiddenOpen}>
				{#each hidden as category (category.id)}
					<div
						class="hidden-row flex min-h-13 items-center gap-3 px-(--row-gutter) py-2"
						data-category-id={category.id}
						style={categoryStyle(category.color)}
					>
						<CategoryPlate icon={category.icon} />
						<span class="h-name flex-1 text-sm font-book text-muted-foreground"
							>{categoryName(category, templatesMap)}</span
						>
						<Button variant="outline" size="sm" onclick={() => void restoreCategory(category)}>
							{t('categories_restore')}
						</Button>
					</div>
				{/each}
			</RuledRows>
		</section>
	{/if}

	{#if missing.length > 0}
		<!-- [D-251] A list made before the seed grew an aisle offers it here. -->
		<section
			class={[cardSurface, 'ce-missing mt-3.5 mx-4 p-3.5 flex flex-col gap-2.5']}
			aria-labelledby="ce-missing-intro"
		>
			<Hint id="ce-missing-intro">
				{t('categories_missing_intro')}
			</Hint>
			<ul class="flex flex-wrap gap-x-3 gap-y-1.5">
				{#each missing as tpl (tpl.slug)}
					<li class="flex items-center gap-1.5 text-sm" style={categoryStyle(tpl.color)}>
						<CategoryPlate icon={tpl.icon} size="head" />
						{categoryName({ name: null, slug: tpl.slug }, templatesMap)}
					</li>
				{/each}
			</ul>
			<Button
				variant="outline"
				disabled={!$online || missingAction.busy}
				onclick={() => void addMissing()}
			>
				{t('categories_missing_add', { count: missing.length })}
			</Button>
			{#if missingAction.error}<ErrorText>{missingAction.error}</ErrorText>{/if}
			{#if !$online}
				<OfflineHint />
			{/if}
		</section>
	{/if}

	<div class="mx-4 mt-3.5 mb-1 flex flex-col">
		{#if movable.length > 1}
			<Button
				bind:ref={arrangeButton}
				variant="outline"
				class="ce-arrange gap-2"
				onclick={() => openMode('arrange-categories')}
			>
				<GripVertical />
				{t('categories_arrange')}
			</Button>
		{/if}
	</div>
{/if}

<CategoryFormSheet
	{listId}
	target={formTarget}
	{categories}
	templates={templatesMap}
	onclose={() => (formTarget = null)}
/>
