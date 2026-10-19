<!--
  A yes/no confirmation as a centered dialog, in place of `window.confirm`
  for the reasons in PromptDialog's header; `busy`/`error` work as there.

  Over the shadcn-svelte AlertDialog (bits-ui, [D-54]), with plain buttons
  rather than AlertDialog.Action/Cancel: the dialog's open state is the
  caller's, which keeps it open across its await (Cancel would close it on
  its own; Action closes nothing). Focus goes to the dialog on open, and
  Cancel comes first in the DOM so tab order reaches the safe choice first.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		AlertDialog,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogTitle
	} from '#lib/components/ui/alert-dialog/index.js';

	interface Props {
		open: boolean;
		title: string;
		/** The question. */
		body: string;
		confirmLabel: string;
		/** Styles the confirm control as destructive: `true` the soft red of an
		 *  act that can be redone, `'strong'` the solid red of the one that
		 *  cannot ([D-214]). */
		danger?: boolean | 'strong';
		busy?: boolean;
		/** Cancel stays live while busy, for a wait the page cannot end itself. */
		cancelWhileBusy?: boolean;
		error?: string;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		body,
		confirmLabel,
		danger = false,
		busy = false,
		cancelWhileBusy = false,
		error,
		onconfirm,
		oncancel
	}: Props = $props();
</script>

<AlertDialog
	bind:open
	onOpenChange={(o) => {
		if (!o) oncancel();
	}}
>
	<AlertDialogContent>
		<AlertDialogTitle>{title}</AlertDialogTitle>
		<AlertDialogDescription class="-mt-2">{body}</AlertDialogDescription>
		{#if error}
			<ErrorText>{error}</ErrorText>
		{/if}
		<!-- Stacked, the confirm on top: side by side, German labels wrap. -->
		<div class="flex flex-col-reverse gap-2">
			<Button
				type="button"
				variant="outline"
				onclick={oncancel}
				disabled={busy && !cancelWhileBusy}
			>
				{t('common_cancel')}
			</Button>
			<Button
				type="button"
				variant={danger === 'strong' ? 'danger' : danger ? 'destructive' : 'default'}
				onclick={onconfirm}
				disabled={busy}
			>
				{confirmLabel}
			</Button>
		</div>
	</AlertDialogContent>
</AlertDialog>
