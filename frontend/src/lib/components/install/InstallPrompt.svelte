<!--
  The install banner (§12), in place of the browser's mini-infobar: shown
  when Chromium has offered installation (#lib/install), and only to a
  signed-in user ([D-231]), never in a demo that is deleted a day later
  ([D-234]). A card at the top of the home screen, not a float over every
  screen ([D-317]): floating, it covered the suggestions and the undo toast
  covered it. "Nicht jetzt" hides it for good; the settings card stays.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { demo } from '#demo';
	import { install, promptInstall } from '#lib/install.svelte.js';
	import { installPromptDismissed } from '#lib/state/prefs.js';
	import {
		Alert,
		AlertTitle,
		AlertDescription,
		AlertAction
	} from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let { class: className }: { class?: string } = $props();

	async function dismiss(): Promise<void> {
		await installPromptDismissed.set(true);
	}
</script>

{#if install.deferred && !$installPromptDismissed && !demo.enabled}
	<Alert role="status" class={className}>
		<AlertTitle>{t('install_title')}</AlertTitle>
		<AlertDescription>{t('install_body')}</AlertDescription>
		<AlertAction>
			<Button variant="ghost" type="button" onclick={() => void dismiss()}>
				{t('install_dismiss')}
			</Button>
			<Button type="button" onclick={() => void promptInstall()}>{t('install_action')}</Button>
		</AlertAction>
	</Alert>
{/if}
