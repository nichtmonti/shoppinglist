<!--
  §5.8's one-tap re-auth as a button ([D-130]): "Sign in again", and "Cancel"
  while the provider's popup is open, as OidcButton does: a tap then gives
  the popup up instead of starting another.
-->
<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Reauth } from '#lib/state/reauth.svelte.js';
	import { t } from '#lib/i18n/index.js';

	const reauth = new Reauth();
</script>

<Button
	type="button"
	disabled={reauth.busy && !reauth.pendingOidc}
	aria-busy={reauth.busy}
	onclick={() => void reauth.run()}
>
	{reauth.pendingOidc ? t('common_cancel') : t('home_expired_action')}
</Button>
