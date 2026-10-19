<!--
  [D-254] A list as text, onto a list: pasted here, or shared to the installed
  app from another one (the manifest's share target opens /import?text=…).
  Two steps on one screen. The paste step takes the text (and still offers a
  backup file, which "Liste importieren" used to open directly). The review
  step is the confirmation: every recognised item under the aisle it will
  land in, each with a checkbox, against the target the user picks. Nothing
  is written before its button.

  The plan (#lib/text-import-plan) is re-derived from the target's live rows,
  so switching the target re-sorts and re-checks against that list. What the
  user unticked, ticked or edited is kept per item across that, and across a
  trip back to the text that leaves the text as it was. A chosen aisle carries
  over as the aisle it is (the same seeded aisle, or a member's of the same
  name); where the other list has none, the plan's guess stands.

  The rows are the list view's own (ListRow, ItemDetailSheet) with a checkbox
  in front: a tap on the name opens the item sheet, the quantity edits in
  place, and both write into this screen's edits instead of the list. The
  review is a history step (a shallow entry, like the arrange modes), so the
  system back and the bar's ‹ return to the text.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { readable } from 'svelte/store';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		closeMode,
		goAcross,
		goBack,
		goUp,
		modeOpen,
		openMode
	} from '#lib/history-layers.svelte.js';
	import { collator, t, getLocale } from '#lib/i18n/index.js';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import { online } from '#lib/state/online.js';
	import {
		categoryTemplates,
		itemDictionary,
		listCategories,
		listRememberedItems,
		memberships
	} from '#lib/state/data.js';
	import { templateLookup } from '#lib/state/template-lookup.js';
	import { categoryName } from '#lib/categories.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import {
		MAX_TEXT_LENGTH,
		detectStructured,
		parseTextList,
		structuredProblem,
		type ParsedText
	} from '#lib/text-import.js';
	import { BACKUP_FORMAT } from '#lib/field-contract.js';
	import { IMPORT_MAX_ITEMS } from '#lib/config.js';
	import {
		backupFromPlan,
		groupRows,
		isSelected as selected,
		planImport,
		rosterCategories,
		rowAsItem,
		selectable,
		statusNote,
		withPatch,
		type PlanRow,
		type RowEdit
	} from '#lib/text-import-plan.js';
	import type { ItemEditPatch } from '#lib/item-edit.js';
	import ListRow from '#lib/components/list/ListRow.svelte';
	import ItemDetailSheet from '#lib/components/list/ItemDetailSheet.svelte';
	import { importBackup, importFailureMessage, importListFromFile } from '#lib/actions/lists.js';
	import { addImported, roomOnList } from '#lib/actions/items.js';
	import { showToast } from '#lib/toasts.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import BackButton from '#lib/components/common/BackButton.svelte';
	import AppBar from '#lib/components/common/AppBar.svelte';
	import SyncBanner from '#lib/components/banner/SyncBanner.svelte';
	import AisleHeader from '#lib/components/common/AisleHeader.svelte';
	import StickyFoot from '#lib/components/common/StickyFoot.svelte';
	import SubScreenTitle from '#lib/components/common/SubScreenTitle.svelte';
	import ScreenTitle from '#lib/components/common/ScreenTitle.svelte';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Field, FieldLabel } from '#lib/components/ui/field/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import type { Item, ListCategory } from '#lib/db.js';

	interface Props {
		/** The list this was opened from (its ⋮ menu): the preset target, and no backup offer. */
		listId?: string | null;
		/** Text shared to the app; the screen opens on its review. */
		sharedText?: string;
		/** The share's subject, a name for a new list when the text carries none. */
		sharedTitle?: string;
	}

	let { listId = null, sharedText = '', sharedTitle = '' }: Props = $props();

	const NEW = '';

	// The props are the screen's starting point, read once: a route keys the
	// screen, so a different list or share is a new one.
	const start = untrack(() => ({ listId, text: sharedText }));
	// A shared file (a backup, a CSV) stays on the paste step, which says what it is.
	const initialKind = detectStructured(start.text, BACKUP_FORMAT);
	const initial = parseTextList(initialKind ? '' : start.text);
	const initialReview = initial.entries.length > 0;

	let text = $state(start.text);
	let parsed = $state<ParsedText | null>(initialReview ? initial : null);
	// The text `parsed` was read from: a review of the same text keeps its
	// ticks, edits and name.
	let parsedFrom = $state(initialReview ? start.text : '');
	let pasteError = $state<string | null>(
		initialKind
			? structuredProblem(initialKind, Boolean(start.listId))
			: start.text && !initialReview
				? t('import_none')
				: null
	);
	// What the text in the field is: a backup turns „Weiter" into its import.
	let pastedKind = $derived(detectStructured(text, BACKUP_FORMAT));
	let pastedBackup = $derived(pastedKind === 'backup' && !listId);
	let target = $state<string>(start.listId ?? NEW);
	let newName = $state(defaultName(initial));
	let busy = $state(false);
	let error = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	const edits = new SvelteMap<string, RowEdit>();
	let openKey = $state<string | null>(null);

	// The review shows while its history entry is up. Asked for and not yet
	// pushed (openMode waits a tick) counts as up, so a share does not flash
	// the paste step first.
	let pending = $state(initialReview);
	if (initialReview) openMode('import-review');
	let entryUp = $derived(modeOpen('import-review'));
	$effect(() => {
		if (entryUp) pending = false;
	});
	let reviewing = $derived(parsed !== null && (entryUp || pending));

	function backToText(): void {
		openKey = null;
		error = null;
		pending = false;
		closeMode('import-review');
	}

	function defaultName(p: ParsedText): string {
		return p.title ?? (sharedTitle.trim() || t('home_import_default_name'));
	}

	const dictionaryStore = itemDictionary();
	const none = readable<never[]>([]);
	let itemsStore = $derived(target === NEW ? none : listRememberedItems(target));
	let categoriesStore = $derived(target === NEW ? none : listCategories(target));
	let roster = $derived(rosterCategories($categoryTemplates));
	let categories = $derived<ListCategory[]>(target === NEW ? roster : $categoriesStore);
	let items = $derived<Item[]>($itemsStore);

	let plan = $derived(
		parsed
			? planImport(
					parsed.entries,
					{
						categories,
						items,
						dictionary: $dictionaryStore,
						templates: $templateLookup,
						locale: getLocale()
					},
					edits
				)
			: []
	);
	let groups = $derived(groupRows(plan, categories, $templateLookup));

	let openRow = $derived(plan.find((r) => r.key === openKey) ?? null);
	let openItem = $derived(openRow ? rowAsItem(openRow, target) : null);

	/** The item sheet's or the quantity control's change, kept as this row's edit. */
	function edit(key: string, patch: ItemEditPatch): void {
		edits.set(key, withPatch(edits.get(key), patch, categories));
	}

	function select(key: string, selected: boolean): void {
		edits.set(key, { ...edits.get(key), selected });
	}

	function isSelected(row: PlanRow): boolean {
		return selected(row, edits.get(row.key));
	}
	let offered = $derived(plan.filter(selectable).length);
	let chosen = $derived(plan.filter(isSelected));

	// The picker waits for the lists: rendered without the preset target's
	// option, it would show „Neue Liste" while the target is that list.
	const listsLoaded = memberships.loaded;
	// By name in the app's language, as the home's alphabetical order is.
	let lists = $derived([...$memberships].sort((a, b) => collator().compare(a.name, b.name)));
	// A target that goes away while the review is open (a member deleted the
	// list, or this account left it elsewhere) falls back to a new list:
	// rows written into it would be refused as gone after the toast said
	// they were added.
	$effect(() => {
		if ($listsLoaded && target !== NEW && !lists.some((l) => l.list === target)) target = NEW;
	});
	let needsOnline = $derived(target === NEW && !$online);
	// An empty name does not disable "create": pressed, it says so under the
	// field ([D-325]).
	let canConfirm = $derived(chosen.length > 0 && !busy && !needsOnline);
	let nameMissing = $state(false);
	$effect(() => {
		if (newName.trim() || target !== NEW) nameMissing = false;
	});

	function review(): void {
		if (!text.trim()) {
			pasteError = t('common_required');
			return;
		}
		const kind = detectStructured(text, BACKUP_FORMAT);
		if (kind) {
			const problem = structuredProblem(kind, Boolean(listId));
			if (problem) pasteError = problem;
			else void importBackupFrom({ text: () => Promise.resolve(text) });
			return;
		}
		if (!parsed || text !== parsedFrom) {
			const next = parseTextList(text);
			if (next.entries.length === 0) {
				pasteError = t('import_none');
				return;
			}
			parsed = next;
			parsedFrom = text;
			newName = defaultName(next);
			edits.clear();
		}
		pasteError = null;
		error = null;
		pending = true;
		openMode('import-review');
	}

	async function leaveFor(id: string): Promise<void> {
		const path = resolve('/list/[id]', { id });
		// Back to the list this came from, rather than a second copy of it on top.
		await (id === listId ? goUp(path) : goAcross(path));
	}

	async function confirm(): Promise<void> {
		if (!canConfirm) return;
		if (target === NEW && !newName.trim()) {
			nameMissing = true;
			return;
		}
		busy = true;
		error = null;
		try {
			if (target === NEW) {
				const name = newName.trim();
				// The server refuses more, with nothing to say which rows to drop.
				if (chosen.length > IMPORT_MAX_ITEMS) {
					error = t('import_too_many', { count: chosen.length, max: IMPORT_MAX_ITEMS });
					return;
				}
				const outcome = await importBackup(backupFromPlan(name, chosen, $categoryTemplates), name);
				if (!outcome.ok) {
					error = importFailureMessage(outcome);
					return;
				}
				await leaveFor(outcome.id);
			} else {
				// The server refuses each create past the list's cap, after the
				// toast below has counted it ([D-217]); tombstones count too.
				const adding = chosen.filter((r) => !r.existing).length;
				const room = await roomOnList(target);
				if (adding > room) {
					error = t('import_list_room', { room: Math.max(0, room) });
					return;
				}
				const count = await addImported(target, chosen);
				showToast(t('import_added', { count }));
				await leaveFor(target);
			}
		} finally {
			busy = false;
		}
	}

	async function pickedFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) await importBackupFrom(file);
	}

	/** A backup, picked as a file or pasted as its text ([D-254]): a new list, as [D-72] imports one. */
	async function importBackupFrom(source: Pick<Blob, 'text'>): Promise<void> {
		busy = true;
		pasteError = null;
		try {
			const outcome = await importListFromFile(source, t('home_import_default_name'));
			if (outcome.ok) await goAcross(resolve('/list/[id]', { id: outcome.id }));
			else pasteError = importFailureMessage(outcome);
		} finally {
			busy = false;
		}
	}

	// Not `title`: the app bar's snippet of that name shadows it, and the h1
	// rendered the snippet instead of the words.
	let screenTitle = $derived(listId ? t('import_add_title') : t('home_import_list'));
</script>

{#if listId}
	<!-- In the list's own app bar, like its other sub-screens. -->
	<SubScreenTitle title={screenTitle} onback={reviewing ? backToText : undefined} />
{:else}
	<AppBar>
		{#snippet back()}
			<BackButton onclick={() => (reviewing ? backToText() : void goBack(resolve('/')))} />
		{/snippet}
		<!-- [D-130]: the chip, and its re-auth, in every app bar. -->
		{#snippet chip()}<SyncBanner />{/snippet}
		{#snippet title()}
			<ScreenTitle title={screenTitle} />
		{/snippet}
	</AppBar>
{/if}

{#if !reviewing}
	<form
		class="px-4 pt-4 pb-6 flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			review();
		}}
	>
		<Field hint={t('import_paste_hint')} error={pasteError ?? undefined}>
			<FieldLabel for="import-text">{t('import_paste_label')}</FieldLabel>
			<Textarea
				id="import-text"
				class="min-h-60 resize-y"
				maxlength={MAX_TEXT_LENGTH}
				dir="auto"
				bind:value={text}
			/>
		</Field>
		<Button type="submit" disabled={busy || (pastedBackup && !$online)}>
			{pastedBackup ? t('import_backup_import') : t('import_next')}
		</Button>

		{#if !listId}
			<div class="mt-4 pt-4 border-t border-border flex flex-col gap-2">
				<Hint>{t('import_backup_hint')}</Hint>
				<!-- eslint-disable-next-line svelte/no-restricted-html-elements -- hidden: the button under it opens the file picker -->
				<input
					bind:this={fileInput}
					type="file"
					accept="application/json,.json"
					class="hidden"
					aria-hidden="true"
					tabindex={-1}
					onchange={(e) => void pickedFile(e)}
				/>
				<Button
					type="button"
					variant="outline"
					disabled={!$online || busy}
					onclick={() => fileInput?.click()}
				>
					{t('import_backup_pick')}
				</Button>
				{#if !$online}
					<OfflineHint />
				{/if}
			</div>
		{/if}
	</form>
{:else}
	<div class="px-4 pt-4 pb-3 flex flex-col gap-3 border-b border-border">
		<Field>
			<FieldLabel for="import-target">{t('import_target')}</FieldLabel>
			{#if $listsLoaded}
				<NativeSelect
					id="import-target"
					value={target}
					onchange={(e) => (target = e.currentTarget.value)}
					disabled={busy}
				>
					<option value={NEW}>{t('import_target_new')}</option>
					{#each lists as list (list.list)}
						<option value={list.list}>{list.name}</option>
					{/each}
				</NativeSelect>
			{:else}
				<div class="h-11" aria-hidden="true"></div>
			{/if}
		</Field>
		{#if target === NEW}
			<Field error={nameMissing ? t('common_required') : undefined}>
				<FieldLabel for="import-name">{t('import_new_name')}</FieldLabel>
				<Input
					id="import-name"
					type="text"
					dir="auto"
					autocomplete="off"
					maxlength={maxBytesFor('lists', 'name')}
					bind:value={newName}
					disabled={busy}
				/>
			</Field>
		{/if}
		<Hint aria-live="polite">
			{t('import_selected', { selected: chosen.length, count: offered })}
		</Hint>
		{#if parsed?.cut}
			<Hint>
				{t('import_text_cut', { max: MAX_TEXT_LENGTH.toLocaleString(getLocale()) })}
			</Hint>
		{/if}
	</div>

	<div class="pb-4">
		{#each groups as group (group.category.id)}
			<AisleHeader
				title={categoryName(group.category, $templateLookup)}
				icon={group.category.icon}
				color={group.category.color}
				count={group.rows.length}
			/>
			{#each group.rows as row, ri (row.key)}
				{@const hint = statusNote(row)}
				{@const nameId = `import-name-${row.key}`}
				<!-- A row already on the list stays as it is: nothing to edit or add. -->
				{@const editable = row.status !== 'on_list'}
				{#snippet check()}
					<!-- 44px of target around a 20px box ([D-56]); the row's own
					     gutter already pads its start. -->
					<label class="-my-2 -ms-2.5 grid size-11 flex-none place-items-center cursor-pointer">
						<Checkbox
							checked={isSelected(row)}
							disabled={!selectable(row) || busy}
							aria-labelledby={nameId}
							aria-describedby={hint ? `${nameId}-hint` : undefined}
							onCheckedChange={(checked) => select(row.key, checked)}
						/>
					</label>
				{/snippet}
				<div data-import-row={row.status} class:text-muted-foreground={!selectable(row)}>
					<ListRow
						item={rowAsItem(row, target)}
						templates={$templateLookup}
						last={ri === group.rows.length - 1}
						lead={check}
						{hint}
						{nameId}
						onopen={editable ? () => (openKey = row.key) : undefined}
						onquantity={(quantity) => edit(row.key, { quantity })}
					/>
				</div>
			{/each}
		{/each}
	</div>

	<ItemDetailSheet
		item={openItem}
		{categories}
		templates={$templateLookup}
		onclose={() => (openKey = null)}
		onedit={(patch) => {
			if (openKey !== null) edit(openKey, patch);
		}}
		onremove={() => {
			if (openKey !== null) select(openKey, false);
		}}
	/>

	<!-- On the bar layer, under which the aisle headers scroll ([D-317]). -->
	<StickyFoot>
		{#if error}
			<ErrorText>{error}</ErrorText>
		{:else if needsOnline}
			<OfflineHint />
		{/if}
		<Button type="button" disabled={!canConfirm} onclick={() => void confirm()}>
			{target === NEW
				? t('import_confirm_new', { count: chosen.length })
				: t('import_confirm_add', { count: chosen.length })}
		</Button>
	</StickyFoot>
{/if}
