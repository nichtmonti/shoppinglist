<!--
  The button family as a living reference ([D-284], [D-311]). The variants and
  sizes are read from buttonVariants, and where each is used from the source,
  so a new variant shows up here with "no rule yet" and an unused one with no
  uses. The patterns and dialogs are the production components.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { t } from '#lib/i18n/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import PromptDialog from '#lib/components/ui/PromptDialog.svelte';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import RemoveItemButton from '#lib/components/list/RemoveItemButton.svelte';
	import Copy from '@lucide/svelte/icons/copy';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Share from '@lucide/svelte/icons/share';
	import type { Theme } from './axes';
	import { buttonUses, type Use } from './button-uses';

	let { themes, width }: { themes: Theme[]; width: string } = $props();

	type Variant = keyof typeof buttonVariants.variants.variant;
	type Size = keyof typeof buttonVariants.variants.size;
	const variants = Object.keys(buttonVariants.variants.variant) as Variant[];
	const sizes = Object.keys(buttonVariants.variants.size) as Size[];
	const textSizes = sizes.filter((z) => !z.startsWith('icon'));
	const iconSizes = sizes.filter((z) => z.startsWith('icon'));

	/** What each level is for. A variant missing here is shown as one without a rule. */
	const ROLES: Partial<Record<Variant, [string, string]>> = {
		default: ['Primär: die eine Hauptaktion einer Fläche, volles Grün.', 'D-284'],
		outline: ['Sekundär: weiß mit fester Kante, nie grün.', 'D-284'],
		ghost: ['Text: für den Rest. Drückt sich grau, denn zartes Grün heißt „gewählt“.', 'D-311'],
		quiet: ['Leises Symbol: Werkzeug einer Zeile oder eines Blatts, nicht dessen Zweck.', 'D-311'],
		'ghost-destructive': ['Rotes Wort: selten und wiederholbar.', 'D-280'],
		destructive: ['Zartes Rot: lässt sich rückgängig machen oder wiederholen.', 'D-214'],
		danger: ['Volles Rot: was nichts zurückbringt.', 'D-214']
	};
	const SIZES: Partial<Record<Size, string>> = {
		default: '44px: jede Textschaltfläche, ob volle Breite oder eigene Breite.',
		sm: '36px gemalt, 44px zum Tippen: nur in einer Zeile oder einem Feld.',
		icon: '40px gemalt, 48px zum Tippen.',
		'icon-sm': '30px gemalt, 44px zum Tippen: Symbole in Zeilen.'
	};

	const uses = buttonUses();

	let dialog = $state<'prompt' | 'confirm' | 'strong' | 'sheet' | null>(null);
	const close = () => (dialog = null);
</script>

{#snippet useList(list: Use[])}
	{#if list.length}
		<details class="uses">
			<summary>{list.length}× verwendet</summary>
			<ul>
				{#each list as use (`${use.file}:${use.line}`)}<li>{use.file}:{use.line}</li>{/each}
			</ul>
		</details>
	{:else}
		<p class="unused">nirgends verwendet: entfernen?</p>
	{/if}
{/snippet}

<div class="buttons-page">
	<section class="rules">
		<h2>Regeln</h2>
		<ul>
			<li>
				Eine Fläche hat höchstens eine grüne Hauptaktion. Zartes Grün ist ein Zustand, nie eine
				Aktion ([D-281]).
			</li>
			<li>
				Jede Aktion ist ein <code>Button</code>. Ein eigenes <code>&lt;button&gt;</code> verweigert
				der Lint, außer für drückbare Zeilen, Kacheln und Statuszeilen, die in
				<code>eslint.shared.config.js</code> mit Grund stehen ([D-311]).
			</li>
			<li>
				Zwei Schaltflächen nebeneinander nur, wenn beide Beschriftungen auf Deutsch bei 360px
				passen; sonst gestapelt, die Hauptaktion oben.
			</li>
			<li>
				Eine Höhe für Textschaltflächen, 44px wie Felder und Zeilen; <code>sm</code> nur in einer Zeile
				oder einem Feld ([D-312]).
			</li>
			<li>Rot ist abgestuft: rotes Wort, zartes Rot, volles Rot ([D-214], [D-280]).</li>
		</ul>
	</section>

	{#each themes as theme (theme)}
		<section class="theme-block" data-theme={theme} class:dark={theme === 'dark'}>
			<h2>Varianten · {theme === 'dark' ? 'Dunkel' : 'Hell'}</h2>
			<div class="matrix" role="region" aria-label="Varianten und Größen">
				{#each variants as variant (variant)}
					{@const role = ROLES[variant]}
					<div class="variant-row" data-button-variant={variant}>
						<div class="variant-head">
							<h3><code>{variant}</code></h3>
							{#if role}
								<p>{role[0]} <span class="ref">[{role[1]}]</span></p>
							{:else}
								<p class="unused">Keine Regel: in ButtonGallery ROLES ergänzen.</p>
							{/if}
							{@render useList(uses.variants.get(variant) ?? [])}
						</div>
						<div class="cells">
							{#each textSizes as size (size)}
								<figure>
									<Button {variant} {size}>{t('common_save')}</Button>
									<figcaption>{size}</figcaption>
								</figure>
							{/each}
							{#each iconSizes as size (size)}
								<figure>
									<Button {variant} {size} aria-label={t('common_actions_for', { name: 'Banane' })}
										><Pencil class="block shrink-0" /></Button
									>
									<figcaption>{size}</figcaption>
								</figure>
							{/each}
							<figure>
								<Button {variant} disabled>{t('common_save')}</Button>
								<figcaption>deaktiviert</figcaption>
							</figure>
						</div>
					</div>
				{/each}
			</div>

			<h2>Größen</h2>
			<div class="sizes">
				{#each sizes as size (size)}
					<div class="size-row">
						<code>{size}</code>
						<p>{SIZES[size] ?? 'Keine Regel: in ButtonGallery SIZES ergänzen.'}</p>
						{@render useList(uses.sizes.get(size) ?? [])}
					</div>
				{/each}
			</div>

			<h2>Muster · {width}px</h2>
			<div class="frame w-(--frame-w)" style:--frame-w={`${width}px`}>
				<figure class="pattern">
					<figcaption>Haupt- und Zweitaktion nebeneinander (Einladungslink)</figcaption>
					<div class="grid grid-cols-2 gap-2">
						<Button><Share aria-hidden="true" />{t('share_share')}</Button>
						<Button variant="outline"><Copy aria-hidden="true" />{t('share_copy')}</Button>
					</div>
				</figure>
				<figure class="pattern">
					<figcaption>Gestapelt, die Hauptaktion oben (Dialoge)</figcaption>
					<div class="flex flex-col-reverse gap-2">
						<Button variant="outline">{t('common_cancel')}</Button>
						<Button>{t('home_action_duplicate')}</Button>
					</div>
				</figure>
				<figure class="pattern">
					<figcaption>Rot abgestuft: zartes Rot, volles Rot</figcaption>
					<div class="flex flex-col gap-2">
						<Button variant="destructive">{t('home_action_leave')}</Button>
						<Button variant="danger">{t('settings_delete_account_confirm')}</Button>
					</div>
				</figure>
				<figure class="pattern">
					<figcaption>Rote Wörter auf den Spalten darüber</figcaption>
					<div class="grid grid-cols-2 gap-2">
						<Button variant="ghost-destructive" size="sm" class="w-full"
							>{t('share_reset_link')}</Button
						>
						<Button variant="ghost-destructive" size="sm" class="w-full"
							>{t('share_revoke_link')}</Button
						>
					</div>
				</figure>
				<figure class="pattern">
					<figcaption>Symbole: Leiste, Zeile, Entfernen</figcaption>
					<div class="flex items-center gap-4">
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('common_actions_for', { name: 'Banane' })}><EllipsisVertical /></Button
						>
						<Button
							variant="quiet"
							size="icon-sm"
							aria-label={t('common_actions_for', { name: 'Banane' })}><Pencil /></Button
						>
						<Button
							variant="quiet"
							size="icon-sm"
							aria-label={t('common_actions_for', { name: 'Banane' })}><EyeOff /></Button
						>
						<RemoveItemButton name="Banane" onremove={() => {}} />
					</div>
				</figure>
			</div>
		</section>
	{/each}

	<section class="live">
		<h2>Dialoge und Blätter, echt</h2>
		<p>Die Produktionskomponenten; sie öffnen sich über der Galerie.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => (dialog = 'prompt')}>Eingabe (Duplizieren)</Button>
			<Button variant="outline" onclick={() => (dialog = 'confirm')}>Bestätigen, zartes Rot</Button>
			<Button variant="outline" onclick={() => (dialog = 'strong')}>Bestätigen, volles Rot</Button>
			<Button variant="outline" onclick={() => (dialog = 'sheet')}>Blatt mit ✕ und Entfernen</Button
			>
		</div>
	</section>
</div>

<PromptDialog
	open={dialog === 'prompt'}
	title={t('home_clone_title')}
	label={t('home_clone_prompt')}
	value={t('home_clone_default_name', { name: 'Wocheneinkauf' })}
	submitLabel={t('home_action_duplicate')}
	onsubmit={close}
	oncancel={close}
/>
<ConfirmDialog
	open={dialog === 'confirm' || dialog === 'strong'}
	title={dialog === 'strong' ? t('settings_delete_account') : t('home_action_leave')}
	body={dialog === 'strong'
		? t('settings_delete_account_no_lists')
		: t('home_leave_confirm', { name: 'Wocheneinkauf' })}
	confirmLabel={dialog === 'strong' ? t('settings_delete_account_confirm') : t('home_action_leave')}
	danger={dialog === 'strong' ? 'strong' : true}
	onconfirm={close}
	oncancel={close}
/>
{#snippet sheetActions()}
	<RemoveItemButton name="Banane" onremove={close} />
{/snippet}
<Sheet
	open={dialog === 'sheet'}
	title="Artikel bearbeiten"
	onclose={close}
	headerActions={sheetActions}
>
	<Hint size="sm">Der Kopf eines Blatts: Titel, Aktionen, ✕.</Hint>
</Sheet>

<style>
	.buttons-page {
		display: grid;
		gap: 28px;
		padding-block: 20px;
	}
	h2 {
		margin-bottom: 12px;
		font-size: 0.9375rem;
		font-weight: 700;
	}
	.rules ul,
	.live p {
		max-width: 80ch;
		font-size: 0.8125rem;
		color: var(--muted-foreground);
	}
	.rules ul {
		display: grid;
		gap: 4px;
		padding-left: 18px;
		list-style: disc;
	}
	.theme-block {
		display: grid;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		color: var(--foreground);
		background: var(--background);
	}
	.matrix {
		display: grid;
		gap: 0;
		overflow-x: auto;
	}
	.variant-row {
		display: grid;
		grid-template-columns: minmax(200px, 280px) 1fr;
		gap: 16px;
		padding-block: 14px;
		border-top: 1px solid var(--border);
	}
	.variant-head h3 {
		font-size: 0.875rem;
		font-weight: 700;
	}
	.variant-head p,
	.size-row p {
		font-size: 0.8125rem;
		color: var(--muted-foreground);
	}
	.ref {
		font-size: 0.75rem;
	}
	.cells {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 16px 20px;
	}
	figure {
		display: grid;
		justify-items: start;
		gap: 6px;
		margin: 0;
	}
	figcaption {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.uses summary,
	.unused {
		font-size: 0.75rem;
	}
	.uses summary {
		cursor: pointer;
		color: var(--muted-foreground);
	}
	.uses ul {
		margin-top: 4px;
		font: 0.6875rem/1.5 var(--font-num);
		color: var(--muted-foreground);
	}
	.unused {
		color: var(--danger);
	}
	.sizes {
		display: grid;
		gap: 8px;
	}
	.size-row {
		display: grid;
		grid-template-columns: 80px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: baseline;
	}
	.frame {
		display: grid;
		gap: 18px;
		max-width: 100%;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface);
	}
	.pattern {
		justify-items: stretch;
	}
</style>
