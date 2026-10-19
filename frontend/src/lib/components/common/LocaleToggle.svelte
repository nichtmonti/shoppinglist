<!--
  The de/en switch (§12.2). Also on the signed-out AuthScreen (and so /join),
  because settings sits behind the account gate and the visitor who cannot
  read the sign-up screen needs it most.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { setLocalePref, localePref } from '#lib/state/prefs.js';
	import { Segmented } from '#lib/components/ui/segmented/index.js';

	let { testid = 'settings-locale' }: { testid?: string } = $props();

	let locale = $derived($localePref);
</script>

<Segmented
	value={locale}
	options={[
		{ value: 'de', label: t('settings_locale_de') },
		{ value: 'en', label: t('settings_locale_en') }
	]}
	onchange={(v) => void setLocalePref(v)}
	label={t('settings_locale')}
	{testid}
/>
