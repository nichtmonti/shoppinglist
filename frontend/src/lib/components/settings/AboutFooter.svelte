<!--
  The about section at the foot of settings ([D-181]): the release, the
  account's code ([D-262]), the source link the AGPL-3.0 requires ([D-211]),
  and the credits the Open Food Facts (ODbL) and OpenMoji (CC BY-SA 4.0)
  licences require.
-->
<script lang="ts">
	import TextLink from '#lib/components/common/TextLink.svelte';
	import { t } from '#lib/i18n/index.js';
	import { appVersion, sourceUrl } from '#lib/config.js';
	import { currentAccountId } from '#lib/auth/state.js';
	import { accountCode } from '#lib/account-code.js';

	// Read once: settings is left when the account changes. An expired session
	// keeps its record, so the code stays.
	const accountId = currentAccountId();
</script>

<footer
	class="about flex flex-col items-center px-4 pt-0.5 pb-4 text-center text-micro text-muted-foreground"
>
	<p>
		<span data-testid="app-version"
			>{appVersion
				? t('settings_about_version', { version: appVersion })
				: t('settings_about_dev')}</span
		>
		·
		{#if accountId}
			<span class="whitespace-nowrap" data-testid="account-code"
				>{t('settings_about_account', { code: accountCode(accountId) })}</span
			>
			·
		{/if}
		<TextLink href={sourceUrl}>{t('settings_about_source')}</TextLink>
	</p>
	<p>
		<TextLink href="https://world.openfoodfacts.org">{t('settings_about_product_data')}</TextLink>
		·
		<TextLink href="https://opendatacommons.org/licenses/odbl/1.0/">ODbL</TextLink>
	</p>
	<p>
		<TextLink href="https://openmoji.org">{t('settings_about_emoji')}</TextLink>
		·
		<TextLink href="https://creativecommons.org/licenses/by-sa/4.0/"
			>{t('settings_about_emoji_license')}</TextLink
		>
	</p>
</footer>
