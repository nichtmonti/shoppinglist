<!--
  §9.1: the row's quantity as a 3-state control: set (opens the inline
  editor), unset ("+ Menge"), editing (a text field). Both buttons are plain
  muted text one step under the name, which is what the row is about; a
  hover or press shows the shop tile's chip fill as the only sign it is a
  control, and the item sheet edits the quantity too ([D-268]). Free text
  ([D-20]), so the set state is width-capped, or it would take the name's
  space ([D-86]). Removing the focused input fires blur synchronously, so
  commit() must be idempotent within one edit.
-->
<script lang="ts">
	import type { Item } from '#lib/db.js';
	import { setQuantity } from '#lib/actions/items.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import { t } from '#lib/i18n/index.js';
	import { displayName } from '#lib/item-name.js';

	interface Props {
		item: Item;
		/** Where a committed value goes; defaults to the item mutation. */
		oncommit?: (value: string) => void | Promise<void>;
	}

	let { item, oncommit }: Props = $props();

	let editing = $state(false);
	let value = $state('');
	// What editing started from: left as it was, nothing is sent, so a
	// co-member's quantity arriving meanwhile is not set back (§8.4).
	let started = '';

	function focusAndSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	function start(): void {
		editing = true;
		// Copied, not bound: a store refresh mid-edit must not clobber a keystroke.
		value = item.quantity;
		started = value;
	}

	async function commit(): Promise<void> {
		if (!editing) return;
		editing = false;
		if (value === started) return;
		await (oncommit ? oncommit(value) : setQuantity(item, value));
	}

	// Both button states. `hover:` applies only where the device can hover, so
	// on a phone the fill shows while pressed and nowhere else.
	const quietClass =
		'appearance-none flex-none inline-flex items-center justify-end min-w-(--qty-w) min-h-7.5 cursor-pointer relative rounded-chip px-1.5 py-0.5 text-qty tabular-nums text-muted-foreground hover:bg-tint-strong hover:text-foreground active:bg-tint-strong active:text-foreground hit-target';

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			void commit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			editing = false;
		}
	}
</script>

{#if editing}
	<input
		class="qty-edit flex-none text-base w-(--qty-w) max-w-[min(60%,320px)] text-foreground bg-surface-2 border border-line-strong rounded-chip px-1.5 py-0.5 [@supports(field-sizing:content)]:w-auto [@supports(field-sizing:content)]:field-sizing-content [@supports(field-sizing:content)]:min-w-(--qty-w)"
		dir="auto"
		maxlength={maxBytesFor('items', 'quantity')}
		enterkeyhint="done"
		bind:value
		onkeydown={onKeydown}
		onblur={() => void commit()}
		aria-label={t('list_edit_quantity')}
		use:focusAndSelect
	/>
{:else if item.quantity}
	<button
		type="button"
		class="qty qty-set {quietClass} max-w-(--qty-max)"
		onclick={start}
		aria-label={t('list_edit_quantity_named', { quantity: item.quantity, name: displayName(item) })}
	>
		<span class="qty-value truncate" dir="auto">{item.quantity}</span>
	</button>
{:else}
	<button
		type="button"
		class="qty qty-unset {quietClass}"
		onclick={start}
		aria-label={t('list_add_quantity_named', { name: displayName(item) })}
	>
		+ {t('common_quantity')}
	</button>
{/if}
