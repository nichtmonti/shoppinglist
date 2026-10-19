<!--
  §9 / §9.1 — the add-item field (list view only): a typeahead over the
  dictionary and this list's picks, minus suppressed names, that is
  dedup-aware before it creates a row (an active match jumps, a checked match
  re-activates). An amount typed with the name ("2 l Milch", "Milch 2 l") is
  the new row's quantity, shown on every candidate before it is picked
  ([D-285]). A name no suggestion covers takes the head-noun classifier's
  aisle (§9 [D-48]); a selected suggestion keeps its own. Enter accepts the top
  match; the as-typed add is the last row, unless a suggestion is exactly the
  typed name ([D-305]).

  `onjump` reveals an existing row after a dedup hit (ListView's). A pasted
  list (two lines or more) goes to this list's import review instead
  ([D-271]).
-->
<script lang="ts">
	import { listRememberedItems, listCategories, itemDictionary } from '#lib/state/data.js';
	import { templateLookup } from '#lib/state/template-lookup.js';
	import { Now } from '#lib/state/clock.svelte.js';
	import { nextMidnight } from '#lib/time.js';
	import { normalizeName } from '#lib/normalize.js';
	import { buildCorpus } from '#lib/classify.js';
	import { buildDictIndex, latestRowByKey, rankSuggestions } from '#lib/typeahead.js';
	import { suppressedNames, suppressName, unsuppressName } from '#lib/state/suppression.js';
	import { addFocusRequested } from '#lib/state/add-focus.js';
	import { handOffImport, isPastedList } from '#lib/import-handoff.js';
	import { goForward } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import { addItemWithUndo, applyDedupHit } from '#lib/actions/items.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import { t, getLocale } from '#lib/i18n/index.js';
	import { showToast } from '#lib/toasts.js';
	import ScanButton from '#lib/scan/ScanButton.svelte';
	import { scannerEnabled } from '#lib/config.js';
	import { Combobox } from 'bits-ui';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		addableName,
		knownNameKeys,
		planAdd,
		resolveSuggestions,
		typedAmount,
		withTypedCandidate
	} from './add-model';
	import SuggestionList from './SuggestionList.svelte';

	interface Props {
		listId: string;
		onjump?: (itemId: string) => void;
		/** Whether the scan button is offered; defaults to the deployment's
		 *  SHOPPINGLIST_SCANNER ([D-218]). */
		scanner?: boolean;
	}

	let props: Props = $props();
	let scanner = $derived(props.scanner ?? scannerEnabled);

	let query = $state('');
	let inputEl: HTMLInputElement | null = $state(null);
	// Driven by the query, because bits-ui opens only on a character keydown and
	// a paste or autofill fires none. bits-ui writes it too (closes on select,
	// Escape, Tab), and that holds until the query changes.
	let open = $derived(query.trim().length > 0);
	// Reset to "" after every selection, so selecting the same value again (the
	// as-typed row on the next add) creates again instead of deselecting.
	let comboboxValue = $state('');

	let itemsStore = $derived(listRememberedItems(props.listId));
	let categoriesStore = $derived(listCategories(props.listId));

	// Per mount: a module-level store would replay a stale value on remount (§6.9).
	const dictionaryStore = itemDictionary();

	// §6.6's living rows plus the removed rows §6.10 still remembers, so typing
	// one of those names re-adds THAT row instead of a duplicate. `buildCorpus`
	// skips tombstones itself.
	let items = $derived($itemsStore);
	let categories = $derived($categoriesStore);
	let templatesMap = $derived($templateLookup);
	let dictionary = $derived($dictionaryStore);
	let suppressed = $derived($suppressedNames);

	// Rebuilt when the list's data or the language changes, not per keystroke.
	let corpus = $derived(buildCorpus(dictionary, items, categories, getLocale()));

	// Not per keystroke either; again on a language switch, which `getLocale()`
	// tracks ([D-291]).
	let dictIndex = $derived(buildDictIndex(dictionary, getLocale()));
	let rowsByKey = $derived(latestRowByKey(items));

	// [D-285] An amount typed with the name ("2 l Milch", "Milch 2 l") is the
	// quantity; the ranking and the as-typed row see the name without it.
	let known = $derived(knownNameKeys(dictIndex, rowsByKey));
	let typed = $derived(typedAmount(query, known));

	let normalizedQuery = $derived(normalizeName(typed.name));

	let listContext = $derived({ categories, templates: templatesMap });

	// Reading `now` re-derives the picks' "heute"/"gestern" at midnight.
	const now = new Now(nextMidnight);
	let suggestions = $derived(
		resolveSuggestions(
			rankSuggestions(normalizedQuery, dictIndex, rowsByKey, suppressed),
			normalizedQuery,
			now.value,
			listContext
		)
	);

	// The as-typed add last, with the aisle the same call an add makes gives it.
	let candidates = $derived(withTypedCandidate(suggestions, typed.name, corpus, listContext));

	function focusInput(): void {
		inputEl?.focus();
	}

	/**
	 * Light dismiss (§9.1 [D-131]), a tap on the scrim: closes the dropdown like
	 * Escape but keeps the query, because a near miss must not cost what was
	 * typed. Focusing the field again reopens it.
	 */
	function dismiss(): void {
		open = false;
		inputEl?.blur();
	}

	// bits-ui highlights the first candidate in an afterTick, so a fast paste +
	// Enter finds nothing highlighted and bits-ui would close without selecting.
	// This runs before bits-ui's handler and keeps the Enter contract instead.
	// Scoped to #add-typeahead, because another open bits-ui listbox carries the
	// same `data-highlighted`.
	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.isComposing) return;
		if (document.querySelector('#add-typeahead [role="option"][data-highlighted]')) return;
		event.preventDefault();
		// With the suggestions closed (Escape, a tap on the scrim) none is in
		// sight: Enter adds what is typed, not a top match nobody sees.
		if (!open) {
			void commitAdd(typed.name, null, typed.quantity);
			return;
		}
		commitCandidate(candidates[0]?.key);
	}

	// §9.1's "+ zur Liste → start typing", requested once by startAdding.
	$effect(() => {
		if (!$addFocusRequested) return;
		focusInput();
		addFocusRequested.set(false);
	});

	/**
	 * The §9.1 dedup-aware add, with the typed amount as its quantity
	 * ([D-285]). Adding a name un-suppresses it first (§6.11).
	 * That call is not gated on the `suppressed` snapshot, which hydrates a tick
	 * after mount: a fast submit would read "not loaded" as "not suppressed".
	 */
	async function commitAdd(
		rawName: string,
		dictSlug: string | null,
		quantity: string
	): Promise<void> {
		const name = addableName(rawName);
		if (!name) return;

		// Clear the field after the await only if it still holds what was
		// committed: a fill typed meanwhile must survive.
		const committedQuery = query;

		await unsuppressName(name);

		// Planned after the await, against the list as it is now.
		const plan = planAdd(name, dictSlug, items, categories, corpus);
		if (query === committedQuery) query = '';

		if (plan.kind === 'existing') {
			await applyDedupHit(plan.item, props.onjump, quantity);
		} else {
			await addItemWithUndo(
				props.listId,
				{ name: plan.name, category_key: plan.categoryKey, quantity },
				t('add_added', { name: plan.name })
			);
		}
		focusInput();
	}

	/**
	 * Commits the candidate `v`, for every selection gesture. A stale highlight
	 * from the previous query's list is still a deliberate selection, so it
	 * commits the top candidate, as Enter does.
	 */
	function commitCandidate(v: string | undefined): void {
		const c = candidates.find((x) => x.key === v) ?? candidates[0];
		if (c) void commitAdd(c.name, c.categorySlug, typed.quantity);
	}

	/**
	 * [D-132] A touch tap selects on its click, never its pointerup: selecting on
	 * pointerup unmounts the dropdown and scrim before the click, which then
	 * lands on the list row underneath and opens that item. Preventing
	 * pointerup's default turns bits-ui's own handler off. A scroll drag fires
	 * no click and selects nothing; mouse and keyboard keep bits-ui's path.
	 */
	let touchPick = '';
	function onItemPointerUp(event: PointerEvent, value: string): void {
		if (event.pointerType !== 'touch') return;
		event.preventDefault();
		touchPick = value;
	}
	function onItemClick(value: string): void {
		if (touchPick !== value) return;
		touchPick = '';
		open = false;
		commitCandidate(value);
	}

	async function suppress(name: string): Promise<void> {
		await suppressName(name);
		showToast(t('add_suppressed', { name }), () => void unsuppressName(name));
	}

	// [D-271] A list pasted in is not one name: its lines go to the import
	// review, which shows each under its aisle before anything is added.
	function pasteList(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (!isPastedList(text)) return;
		event.preventDefault();
		handOffImport(text);
		void goForward(resolve('/list/[id]/import', { id: props.listId }));
	}
</script>

<Combobox.Root
	type="single"
	loop={false}
	bind:value={comboboxValue}
	bind:open
	inputValue={query}
	onValueChange={(v) => {
		if (!v) return;
		comboboxValue = '';
		commitCandidate(v);
	}}
>
	<!-- .addwrap is the sticky element: a sticky child cannot out-travel its
	     containing block. It takes the bar layer, above the aisle headers' sticky one: as a
	     stacking context, a z-index inside it counts only within its own slot.
	     Inside, 1 scrim, 2 field, 3 dropdown; the bar takes no layer, so the
	     scrim dims it and only the field stays lit ([D-131]).
	     design-tokens.test.ts pins the order. -->
	<div class="addwrap sticky top-0 z-(--layer-bar)">
		<!-- The light-dismiss scrim (§9.1 [D-131]): a near miss below the last
		     suggestion would otherwise open an unrelated item's sheet. Visibly
		     dimmed, since an invisible guard makes every row a dead control
		     ([D-124]). Fixed, which still lets the page scroll. It dismisses on
		     click, and stops pointerdown from reaching bits-ui's dismissible
		     layer, which would unmount the scrim mid-tap and drop the pointerup
		     on the row underneath. Out of the tab order and a11y tree: Escape
		     is the keyboard's dismiss. -->
		{#if open}
			<button
				type="button"
				tabindex="-1"
				aria-hidden="true"
				data-testid="ta-scrim"
				class="ta-scrim fixed inset-0 z-1 block bg-(--scrim) cursor-default duration-100 animate-in fade-in-0"
				onpointerdown={(event) => event.stopPropagation()}
				onclick={dismiss}
			></button>
		{/if}
		<div
			class="addbar relative flex h-(--band-h) items-center gap-2 px-3.5 bg-surface border-b border-border"
		>
			<!-- The field, with its + and the scanner inside it ([D-277]): one
			     filled shape that says "add" at rest, not an empty form box with a
			     camera beside it. Focus shows on the shape, as the one outline ([D-315]). The
			     + is grey and lies over the input's padding, so a tap on it opens
			     the keyboard: green is for what can be pressed ([D-290]). -->
			<div
				class="add-field relative z-2 flex flex-1 min-w-0 items-center rounded-control border border-transparent bg-tint has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-primary-text has-[input:focus-visible]:bg-surface-2"
			>
				<Plus
					class="size-4.5 add-plus pointer-events-none absolute inset-s-3 top-1/2 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<!-- text-base (16px): iOS Safari zooms on focus into any smaller input. -->
				<Combobox.Input
					bind:ref={inputEl}
					type="text"
					class="add-input flex-1 min-w-0 text-base text-foreground ps-10 pe-3 py-2 placeholder:text-muted-foreground focus-visible:outline-none"
					dir="auto"
					maxlength={maxBytesFor('items', 'name')}
					autocomplete="off"
					enterkeyhint="go"
					placeholder={t('add_placeholder')}
					aria-label={t('add_label')}
					aria-controls="add-typeahead"
					oninput={(e) => (query = e.currentTarget.value)}
					onkeydown={handleKeydown}
					onpaste={pasteList}
					onfocus={() => {
						// The derived's rule again, so a scrim dismiss ([D-131])
						// is undone by tapping back into the field.
						if (query.trim()) open = true;
					}}
				/>
				<!-- A scan reveals its row like the typeahead's dedup jump (§9.2), so
				     scanning something already on the list scrolls to it. -->
				{#if scanner}
					<span class="-ms-1 me-0.5 flex shrink-0">
						<ScanButton
							listId={props.listId}
							onfallback={focusInput}
							onadded={(itemId) => props.onjump?.(itemId)}
						/>
					</span>
				{/if}
			</div>
		</div>

		{#if open}
			<!-- The wrapper carries the aria-controls id: bits-ui's ContentStatic
			     never puts an id prop on the listbox element. -->
			<div id="add-typeahead">
				<SuggestionList
					{candidates}
					quantity={typed.quantity}
					onitempointerup={onItemPointerUp}
					onitemclick={onItemClick}
					onsuppress={(name) => void suppress(name)}
				/>
			</div>
		{/if}
	</div>
</Combobox.Root>
