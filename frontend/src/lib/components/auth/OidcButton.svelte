<!--
  The OIDC login button. While the provider popup is open it becomes
  "Abbrechen": the page cannot tell whether the popup is still there (see
  oidcLogin), so a user who closed it needs a way out of the pending attempt.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/index.js';
	import { cancelOidcLogin } from '#lib/auth/index.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		pending,
		onstart,
		disabled = false,
		class: className,
		children
	}: {
		/** The popup flow is under way. */
		pending: boolean;
		onstart: () => void;
		disabled?: boolean;
		class?: string;
		/** The start label ("Weiter mit ‹name›"). */
		children: Snippet;
	} = $props();
</script>

{#if pending}
	<Button variant="outline" type="button" class={className} onclick={cancelOidcLogin}>
		{t('common_cancel')}
	</Button>
{:else}
	<Button variant="outline" type="button" class={className} {disabled} onclick={onstart}>
		{@render children()}
	</Button>
{/if}
