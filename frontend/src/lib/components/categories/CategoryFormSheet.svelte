<!--
  §6.7 [D-37] the category editor's add/edit form: name, an emoji picker, and a
  color picker restricted to the curated palette, plus "reset to default" for a
  template-born category. Mutations go through #lib/actions/categories.ts.
-->
<script lang="ts">
	import emojiSet from '#lib/emoji-set.json';
	import { untrack } from 'svelte';
	import CategoryIcon from '#lib/components/common/CategoryIcon.svelte';
	import { RadioGroup } from 'bits-ui';
	import type { CategoryTemplate, ListCategory } from '#lib/db.js';
	import {
		COLOR_LABEL_KEYS,
		PALETTE,
		categoryStyle,
		templateDefaultName,
		categoryNameTaken,
		nextSortOrder
	} from '#lib/categories.js';
	import { t } from '#lib/i18n/index.js';
	import { addCategory, editCategory, resetCategoryToTemplate } from '#lib/actions/categories.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import { Field, FieldLabel } from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import { PickerTile } from '#lib/components/ui/picker-tile/index.js';
	import {
		categoryEditFields,
		type CategoryDrafts,
		type CategoryFormTarget
	} from './category-form';

	interface Props {
		listId: string;
		/** The open form, or null when the sheet is closed. */
		target: CategoryFormTarget | null;
		categories: ListCategory[];
		templates: Map<string, CategoryTemplate>;
		onclose: () => void;
	}

	let { listId, target, categories, templates, onclose }: Props = $props();

	// A fixed curated set, shared with the OpenMoji sync script through
	// #lib/emoji-set.json ([D-181]): a pick without artwork fails CI.
	const EMOJI_PICK: string[] = emojiSet.pick;

	// A new category's starting icon and colour.
	const NEW_ICON = '🛒';
	const NEW_COLOR = 'green';
	let draftName = $state('');
	let draftIcon = $state(NEW_ICON);
	let draftColor = $state(NEW_COLOR);

	// The form keeps showing what it was opened on while the sheet animates
	// closed, so its title and reset button do not flip under the exit.
	let shown = $state<CategoryFormTarget>({ kind: 'add' });
	let mode = $derived(shown.kind);
	// Resolved by id against the live rows: a co-member's edit to the open
	// category shows up in its template link and save target.
	let editing = $derived.by(() => {
		const open = shown;
		return open.kind === 'edit' ? (categories.find((c) => c.id === open.id) ?? null) : null;
	});

	// Seed the drafts once per opening, never on a live refresh of the row,
	// which would clobber what the user is typing.
	let seededKey: string | null = null;
	// The drafts as opened: Save sends only what the user changed since, so a
	// co-member's rename arriving meanwhile is not written back over (§8.4).
	let opened: CategoryDrafts = { name: '', icon: '', color: '' };
	$effect.pre(() => {
		const open = target;
		const key = open === null ? null : open.kind === 'add' ? 'add' : `edit:${open.id}`;
		if (key === seededKey) return;
		seededKey = key;
		if (!open) return;
		untrack(() => {
			shown = open;
			const category = open.kind === 'edit' ? categories.find((c) => c.id === open.id) : undefined;
			draftName = category?.name ?? '';
			draftIcon = category?.icon ?? NEW_ICON;
			draftColor = category?.color ?? NEW_COLOR;
			opened = { name: draftName, icon: draftIcon, color: draftColor };
		});
	});

	let editingTemplate = $derived(editing?.slug ? templates.get(editing.slug) : undefined);
	let namePlaceholder = $derived(
		(editing && templateDefaultName(editing, templates)) || t('categories_name_placeholder')
	);
	let formTitle = $derived(mode === 'edit' ? t('categories_edit_one') : t('categories_add'));

	// One save at a time: the sheet closes only after the write, and a double
	// tap on Speichern would otherwise add the category twice.
	let saving = false;

	async function saveForm(): Promise<void> {
		if (saving) return;
		saving = true;
		try {
			// A name another category shows is not saved: the sheet stays open
			// on it, so the name can be changed and nothing else is lost.
			if (!(await writeForm())) return;
		} finally {
			saving = false;
		}
		onclose();
	}

	/** Saves the form; false when its name is taken and nothing was saved. */
	async function writeForm(): Promise<boolean> {
		if (mode === 'add') {
			const name = draftName.trim() || t('categories_new_default_name');
			if (nameTaken(name)) return false;
			await addCategory(listId, {
				name,
				icon: draftIcon,
				color: draftColor,
				sort_order: nextSortOrder(categories)
			});
		} else if (editing) {
			const category = editing;
			const drafts = { name: draftName, icon: draftIcon, color: draftColor };
			const fields = categoryEditFields(drafts, opened, category);
			if (fields.name !== undefined) {
				const shown = fields.name ?? templateDefaultName(category, templates);
				if (nameTaken(shown, category.id)) return false;
			}
			await editCategory(category, fields);
		}
		return true;
	}

	// Said under the name, where it can be changed ([D-325]); cleared as it is.
	let takenError = $derived.by<string | undefined>(() => {
		void draftName;
		return undefined;
	});

	function nameTaken(name: string, exceptId?: string): boolean {
		if (!categoryNameTaken(name, categories, templates, exceptId)) return false;
		takenError = t('categories_name_taken', { name });
		return true;
	}

	async function resetForm(): Promise<void> {
		const category = editing;
		const template = editingTemplate;
		if (!category || !template || saving) return;
		saving = true;
		try {
			await resetCategoryToTemplate(category, template);
		} finally {
			saving = false;
		}
		onclose();
	}
</script>

<Sheet open={target !== null} title={formTitle} {onclose}>
	<Field error={takenError}>
		<FieldLabel for="ce-form-name">
			{t('common_name')}
		</FieldLabel>
		<Input
			id="ce-form-name"
			dir="auto"
			maxlength={maxBytesFor('list_categories', 'name')}
			bind:value={draftName}
			placeholder={namePlaceholder}
		/>
	</Field>
	<Field>
		<FieldLabel id="ce-form-emoji">{t('categories_emoji')}</FieldLabel>
		<RadioGroup.Root
			value={draftIcon}
			onValueChange={(v) => {
				if (v) draftIcon = v;
			}}
			aria-labelledby="ce-form-emoji"
			data-testid="emoji-grid"
			orientation="horizontal"
			class="grid grid-cols-6 gap-1.5"
		>
			{#each EMOJI_PICK as emoji (emoji)}
				<PickerTile
					value={emoji}
					aria-label={emoji}
					class="icon-plate grid aspect-square place-items-center rounded-control border border-border hover:border-line-strong"
					><CategoryIcon icon={emoji} chip={2.25} /></PickerTile
				>
			{/each}
		</RadioGroup.Root>
	</Field>
	<Field>
		<FieldLabel id="ce-form-color">{t('categories_color')}</FieldLabel>
		<RadioGroup.Root
			value={draftColor}
			onValueChange={(v) => {
				if (v) draftColor = v;
			}}
			aria-labelledby="ce-form-color"
			data-testid="color-grid"
			orientation="horizontal"
			class="flex flex-wrap gap-2"
		>
			{#each PALETTE as token (token)}
				<PickerTile
					value={token}
					aria-label={t(COLOR_LABEL_KEYS[token])}
					style={categoryStyle(token)}
					class="size-11 rounded-full bg-(--c) border-2 border-surface ring-1 ring-border hover:ring-line-strong"
				/>
			{/each}
		</RadioGroup.Root>
	</Field>
	{#if mode === 'edit' && editingTemplate}
		<Button variant="ghost" class="ce-reset w-full" onclick={() => void resetForm()}>
			{t('categories_reset_default')}
		</Button>
	{/if}
	<!-- Save stays on screen while the pickers scroll ([D-327]). -->
	{#snippet footer()}
		<Button type="button" class="ce-form-save w-full" onclick={() => void saveForm()}>
			{t('common_save')}
		</Button>
	{/snippet}
</Sheet>
