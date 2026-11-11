<!--
  §12 settings: the passkeys group ([D-269]). A row per passkey opens a sheet
  to rename or remove it (confirmed); the add row asks for the new one's name
  first, since the name is how the keys are told apart ([D-214]).
-->
<script lang="ts">
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import Hint from '#lib/components/common/Hint.svelte';
	import { onMount } from 'svelte';
	import { t, relativeTime } from '#lib/i18n/index.js';
	import { online } from '#lib/state/online.js';
	import { authMethods } from '#lib/state/auth-methods.js';
	import {
		listPasskeys,
		removePasskey,
		renamePasskey,
		type PasskeyRow
	} from '#lib/actions/account.js';
	import { addPasskey } from '#lib/auth/index.js';
	import { AsyncAction, AsyncDialog } from '#lib/state/async-action.svelte.js';
	import { Kept } from '#lib/state/kept.svelte.js';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import PromptDialog from '#lib/components/ui/PromptDialog.svelte';
	import { maxBytesFor } from '#lib/field-contract.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	// The list the route read before the screen rendered ([D-205]); `null`
	// when it did not arrive in time, and the group asks itself.
	let { preloaded = null }: { preloaded?: PasskeyRow[] | null } = $props();

	// Derived from the route's read, and overwritten by every load here.
	let passkeys = $derived<PasskeyRow[]>(preloaded ?? []);
	// The server refuses to remove an account's last login (§5.4), so the row
	// says so before the user asks ([D-293]).
	let onlyLogin = $derived(passkeys.length === 1 && $authMethods?.oidc.linked !== true);

	const loadAction = new AsyncAction();

	// "No passkeys" is an answer, so it waits for the first list to arrive.
	let passkeysLoaded = $derived(preloaded !== null);

	async function loadPasskeys(): Promise<void> {
		const attempt = await loadAction.run(() => listPasskeys());
		if (attempt.ok) {
			passkeys = attempt.value;
			passkeysLoaded = true;
		}
	}

	onMount(() => {
		if (!passkeysLoaded) void loadPasskeys();
	});

	function passkeyLabel(p: PasskeyRow): string {
		return p.friendly_name || t('settings_passkey_unnamed');
	}

	// One layer open at a time: a passkey's sheet, its rename prompt, its
	// removal (a failure renders inside the open confirmation), or the add
	// prompt. The prompts finish on close: a rename or a ceremony that went
	// through still reloads the list.
	let chosen = $state<PasskeyRow | null>(null);
	// What its sheet shows, kept while it slides closed.
	const shownKey = new Kept(() => chosen);
	const renaming = new AsyncDialog<PasskeyRow>({ onClose: 'finish' });
	const adding = new AsyncDialog<true>({ onClose: 'finish' });
	const confirm = new AsyncDialog<{ id: string; label: string }>({ onClose: 'forget' });

	function startRename(p: PasskeyRow): void {
		chosen = null;
		renaming.open(p);
	}

	async function renameTo(id: string, name: string): Promise<void> {
		if ((await renaming.run(() => renamePasskey(id, name))).ok) await loadPasskeys();
	}

	function startRemove(p: PasskeyRow): void {
		chosen = null;
		confirm.open({ id: p.id, label: passkeyLabel(p) });
	}

	async function confirmRemovePasskey(id: string): Promise<void> {
		if ((await confirm.run(() => removePasskey(id))).ok) await loadPasskeys();
	}

	async function confirmAddPasskey(name: string): Promise<void> {
		if ((await adding.run(() => addPasskey(name))).ok) await loadPasskeys();
	}
</script>

<SettingsGroup title={t('settings_passkeys')} icon="🔑" color="amber">
	{#each passkeys as p (p.id)}
		<!-- The name wraps, never truncates: it tells the keys apart before
		     removing one ([D-214]). -->
		<SettingsRow
			label={passkeyLabel(p)}
			hint={p.last_used_at
				? t('settings_passkey_last_used', { when: relativeTime(p.last_used_at) })
				: t('settings_passkey_never_used')}
			opens
			onclick={() => (chosen = p)}
			testid="passkey-row"
		/>
	{/each}
	<SettingsRow
		label={t('settings_add_passkey')}
		disabled={!$online}
		opens
		onclick={() => adding.open(true)}
	>
		{#snippet icon()}<Plus class="text-primary-text" aria-hidden="true" />{/snippet}
	</SettingsRow>
	{#snippet footnote()}
		<!-- A group's grey footnote is micro, the row hints' size ([D-351]). -->
		{#if loadAction.error}
			<ErrorText>{loadAction.error}</ErrorText>
		{:else if passkeysLoaded && passkeys.length === 0}
			<Hint size="micro">{t('settings_no_passkeys')}</Hint>
		{:else if passkeys.length === 1}
			<!-- The nudge is for the second key; with two it has done its job. -->
			<Hint size="micro">{t('settings_backup_key_nudge')}</Hint>
		{/if}
	{/snippet}
</SettingsGroup>

<Sheet
	open={chosen !== null}
	title={shownKey.value ? passkeyLabel(shownKey.value) : ''}
	onclose={() => (chosen = null)}
>
	{#if shownKey.value}
		{@const p = shownKey.value}
		<!-- The note under the rows it explains, 8px below ([D-327]). -->
		<div class="flex flex-col gap-2">
			<RuledRows flush>
				<SettingsRow
					label={t('common_rename')}
					flush
					opens
					disabled={!$online}
					onclick={() => startRename(p)}
				/>
				<SettingsRow
					label={t('settings_remove_passkey')}
					tone="danger"
					flush
					disabled={!$online || onlyLogin}
					opens
					onclick={() => startRemove(p)}
				/>
			</RuledRows>
			{#if onlyLogin}<Hint>
					{t('settings_passkey_only_login')}
				</Hint>
			{:else if !$online}<OfflineHint message={t('settings_online_only')} />{/if}
		</div>
	{/if}
</Sheet>

<PromptDialog
	open={renaming.current !== null}
	title={t('settings_rename_passkey_named', {
		name: renaming.last ? passkeyLabel(renaming.last) : ''
	})}
	label={t('settings_rename_passkey_label')}
	value={renaming.last?.friendly_name ?? ''}
	maxlength={maxBytesFor('credentials', 'friendly_name')}
	busy={renaming.busy}
	error={renaming.error}
	onsubmit={(name) => renaming.current && void renameTo(renaming.current.id, name)}
	oncancel={() => renaming.close()}
/>

<PromptDialog
	open={adding.current !== null}
	title={t('settings_add_passkey')}
	label={t('settings_new_passkey_label')}
	placeholder={t('settings_passkey_name_placeholder')}
	submitLabel={t('settings_add_passkey')}
	maxlength={maxBytesFor('credentials', 'friendly_name')}
	busy={adding.busy}
	error={adding.error}
	onsubmit={(name) => void confirmAddPasskey(name)}
	oncancel={() => adding.close()}
/>

{#if confirm.last}
	{@const c = confirm.last}
	<ConfirmDialog
		open={confirm.current !== null}
		title={t('settings_remove_passkey')}
		body={t('settings_remove_passkey_confirm', { name: c.label })}
		confirmLabel={t('settings_remove_passkey_confirm_action')}
		danger
		busy={confirm.busy}
		error={confirm.error}
		onconfirm={() => void confirmRemovePasskey(c.id)}
		oncancel={() => confirm.close()}
	/>
{/if}
