<!--
  The auth screen on a demo instance ([D-234]): one button in, to a throwaway
  account and the overview of its example lists. Not on /join: JoinScreen
  carries on into the invited list.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.js';
	import { AsyncAction } from '#lib/state/async-action.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import FocusTitle from '#lib/components/common/FocusTitle.svelte';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { createExampleLists, startDemo } from './start';

	const action = new AsyncAction();
	// [D-335] Over http:// at any address but localhost the browser withholds
	// what the sync needs; say so rather than start a demo that cannot work.
	const secure = window.isSecureContext;
	const localUrl = `http://localhost${location.port ? `:${location.port}` : ''}`;

	async function begin(): Promise<void> {
		const joining = page.url.pathname.startsWith('/join');
		await startDemo();
		if (joining) return;
		// Best-effort: the visitor is in either way. The import is online-only,
		// and the start just proved online.
		await createExampleLists().catch(() => null);
	}
</script>

<FocusTitle title={t('demo_title')} locale />
<Hint size="sm">{t('demo_intro')}</Hint>
<Button
	class="mt-4"
	data-testid="demo-start"
	onclick={() => void action.run(begin)}
	disabled={action.busy || !secure}
	aria-busy={action.busy}
>
	{t('demo_start')}
</Button>
<Hint>{t('demo_start_note')}</Hint>
{#if !secure}
	<ErrorText size="sm">{t('demo_insecure', { url: localUrl })}</ErrorText>
{:else if action.error}
	<ErrorText size="sm">{action.error}</ErrorText>
{/if}
