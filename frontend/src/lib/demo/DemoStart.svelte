<!--
  The auth screen on a demo instance ([D-234]): one button in, to a throwaway
  account and an opened example list. Not on /join: JoinScreen carries on into
  the invited list.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
	import { goForward } from '#lib/history-layers.svelte.js';
	import { AsyncAction } from '#lib/state/async-action.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import FocusTitle from '#lib/components/common/FocusTitle.svelte';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { createExampleList, startDemo } from './start';

	const action = new AsyncAction();

	async function begin(): Promise<void> {
		const joining = page.url.pathname.startsWith('/join');
		await startDemo();
		if (joining) return;
		// Best-effort: the visitor is in either way. createList is online-only,
		// and the start just proved online.
		const listId = await createExampleList().catch(() => null);
		if (listId) await goForward(resolve('/list/[id]', { id: listId }));
	}
</script>

<FocusTitle title={t('demo_title')} locale />
<Hint size="sm">{t('demo_intro')}</Hint>
<Button
	class="mt-4"
	data-testid="demo-start"
	onclick={() => void action.run(begin)}
	disabled={action.busy}
	aria-busy={action.busy}
>
	{t('demo_start')}
</Button>
<Hint>{t('demo_start_note')}</Hint>
{#if action.error}
	<ErrorText size="sm">{action.error}</ErrorText>
{/if}
