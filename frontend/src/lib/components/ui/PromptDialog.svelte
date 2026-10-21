<!--
  A single-field prompt as a centered dialog, in place of `window.prompt`,
  which ignores the design system and is synchronous, leaving nowhere to put
  "saving…" or an error. Hence `busy` and `error` are props: the caller stays
  open across its own await, renders a rejection next to the input, and
  decides when to close.

  Over the shadcn-svelte Dialog (bits-ui, [D-54]): portal, focus trap and
  return, scroll lock and Escape.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '#lib/i18n/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogTitle
	} from '#lib/components/ui/dialog/index.js';
	import { Field, FieldLabel } from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';

	interface Props {
		open: boolean;
		title: string;
		/** Micro-label above the input. */
		label: string;
		/** Optional sentence between the title and the field. */
		description?: string;
		/** Seed value; re-read each time the sheet opens. */
		value?: string;
		placeholder?: string;
		/**
		 * A keyboard guard from the field contract ([D-08]); it counts UTF-16
		 * units, the server UTF-8 bytes, so the server's 400 stays the backstop.
		 */
		maxlength?: number;
		submitLabel?: string;
		/** Disables the form while the caller's mutation is in flight. */
		busy?: boolean;
		/** Rendered inline instead of closing the sheet. */
		error?: string;
		onsubmit: (value: string) => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		label,
		description,
		value = '',
		placeholder,
		maxlength,
		submitLabel,
		busy = false,
		error,
		onsubmit,
		oncancel
	}: Props = $props();

	let draft = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);

	// Re-seed on each open only (`untrack`): the draft must not snap back under
	// the user if another device renames the list mid-edit (§8.5).
	$effect(() => {
		if (open) draft = untrack(() => value);
	});

	let trimmed = $derived(draft.trim());
	// Never disabled for an empty field: a disabled button cannot say what it
	// waits for, so pressed early it says so under the field ([D-325]).
	// Set by a press on an empty field; the next change to the text takes it
	// back (a writable $derived).
	let missing = $derived.by(() => {
		void trimmed;
		return false;
	});

	function submit(event: Event) {
		event.preventDefault();
		if (busy) return;
		if (!trimmed) {
			missing = true;
			inputRef?.focus();
			return;
		}
		onsubmit(trimmed);
	}
</script>

<Dialog
	bind:open
	onOpenChange={(o) => {
		if (!o) oncancel();
	}}
>
	<!-- The field takes the opening focus with its text selected, so a rename
	     does not start with the caret at 0. -->
	<DialogContent
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			inputRef?.focus();
			inputRef?.select();
		}}
	>
		<DialogTitle>{title}</DialogTitle>
		{#if description}
			<DialogDescription class="-mt-2">{description}</DialogDescription>
		{/if}
		<form onsubmit={submit} class="flex flex-col">
			<Field class="mb-4" error={error ?? (missing ? t('common_required') : undefined)}>
				<FieldLabel for="prompt-sheet-input">{label}</FieldLabel>
				<Input
					id="prompt-sheet-input"
					type="text"
					dir="auto"
					autocomplete="off"
					enterkeyhint="done"
					bind:value={draft}
					bind:ref={inputRef}
					{placeholder}
					{maxlength}
					disabled={busy}
				/>
			</Field>
			<!-- Stacked, the primary on top: side by side, German labels wrap. -->
			<div class="flex flex-col-reverse gap-2">
				<Button type="button" variant="outline" onclick={oncancel} disabled={busy}>
					{t('common_cancel')}
				</Button>
				<Button type="submit" disabled={busy}>
					{submitLabel ?? t('common_save')}
				</Button>
			</div>
		</form>
	</DialogContent>
</Dialog>
