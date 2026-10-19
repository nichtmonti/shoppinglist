<!-- Development-only controls around the production components. No app stores are written. -->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { replaceOwnUrl } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import type { Item } from '#lib/db.js';
	import { getLocale, setLocale } from '#lib/i18n/index.js';
	import { itemSortOrDefault } from '#lib/sorting.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import RemoveItemButton from '#lib/components/list/RemoveItemButton.svelte';
	import GalleryPreview from './GalleryPreview.svelte';
	import ButtonGallery from './ButtonGallery.svelte';
	import DesignGallery from './DesignGallery.svelte';
	import { fixtures } from './fixtures';
	import { AXES, AXIS_IDS, parseState, toSearch, type Axis, type GalleryState } from './axes';
	import { COMPARISONS, CURRENT } from './comparisons';
	import './comparisons/layout.css';

	// Every setting is an axis (axes.ts) and lives in the URL.
	const s = $state<GalleryState>(parseState(new URLSearchParams(location.search)));
	let ready = $state(false);
	let revision = $state(0);
	let selected = $state<{ item: Item; remove?: () => void } | null>(null);

	onMount(() => (ready = true));
	$effect(() => {
		const query = toSearch(s);
		if (!ready) return;
		void replaceOwnUrl(`${resolve('/dev/gallery')}${query ? `?${query}` : ''}`);
	});

	const bootLocale = getLocale();
	const bootFont = document.documentElement.style.fontSize;
	const baseSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
	// Before the first render, and before every re-render the locale keys.
	setLocale(s.locale);
	$effect.pre(() => setLocale(s.locale));
	$effect.pre(() => {
		document.documentElement.style.fontSize = `${(baseSize * Number(s.scale)) / 100}px`;
	});
	onDestroy(() => {
		setLocale(bootLocale);
		document.documentElement.style.fontSize = bootFont;
	});

	function toggle(id: keyof GalleryState, value: string, on: boolean) {
		const list = s[id] as string[];
		const next = on ? [...list, value] : list.filter((v) => v !== value);
		// A matrix axis never goes empty: the last box stays ticked.
		if (next.length) (s[id] as string[]) = next;
	}
	const groups = { main: [], more: [] } as Record<Axis['group'], (keyof GalleryState)[]>;
	for (const id of AXIS_IDS) groups[AXES[id].group].push(id);

	let views = $derived((['shop', 'list'] as const).filter((v) => s.view.includes(v)));
	const viewLabels = { shop: 'Einkaufen', list: 'Bearbeiten' };
	const themeLabels = { light: 'Hell', dark: 'Dunkel' };
	const densityLabels = {
		comfortable: 'Komfortabel',
		compact: 'Kompakt',
		list: 'Liste'
	};
	let examples = $derived(fixtures(s.content, s.state, s.kind));
	// The app first, always; a proposal row under it when one is picked.
	let versions = $derived([CURRENT, ...COMPARISONS.filter((c) => c.id === s.compare)]);
</script>

{#snippet control(id: keyof GalleryState)}
	{@const axis: Axis = AXES[id]}
	{@const disabled = axis.disabled?.(s) ?? false}
	{#if axis.type === 'flag'}
		<label class="check"
			><input type="checkbox" {id} bind:checked={s[id] as boolean} {disabled} />
			{axis.label}</label
		>
	{:else if axis.type === 'one'}
		<div>
			<label for={id}>{axis.label}</label><select {id} bind:value={s[id] as string} {disabled}>
				{#each axis.choices as [value, label] (value)}<option {value}>{label}</option>{/each}
			</select>
		</div>
	{:else}
		<fieldset {id} {disabled}>
			<legend>{axis.label}</legend>
			{#each axis.choices as [value, label] (value)}
				<label class="check"
					><input
						type="checkbox"
						{value}
						checked={(s[id] as string[]).includes(value)}
						onchange={(e) => toggle(id, value, e.currentTarget.checked)}
					/>
					{label}</label
				>
			{/each}
		</fieldset>
	{/if}
{/snippet}

<div class="gallery" class:outlines={s.outlines} data-gallery-ready={ready || undefined}>
	<header class="toolbar">
		<h1>Design-Galerie</h1>
		<p>
			Alle Zustände der Liste mit den Produktionskomponenten. Die erste Reihe ist immer die aktuelle
			App; ein gewählter Vergleich zeigt darunter einen offenen Vorschlag mit wenigen, gekapselten
			Style-Anpassungen. „Seite: Buttons“ zeigt die Schaltflächen-Familie mit ihren Regeln,
			„Gestaltung“ Schrift, Radien, Farben, Symbole und Felder. Die Adresse hält alle Einstellungen
			fest.
		</p>
		<div class="controls">
			{#each groups.main as id (id)}{@render control(id)}{/each}
			<Button variant="outline" onclick={() => revision++}>Zurücksetzen</Button>
		</div>
		<details class="options">
			<summary>Weitere Optionen</summary>
			<div class="controls">
				{#each groups.more as id (id)}{@render control(id)}{/each}
			</div>
		</details>
	</header>

	{#if s.page === 'buttons'}
		{#key s.locale}<ButtonGallery themes={s.theme} width={s.width} />{/key}
	{:else if s.page === 'design'}
		{#key s.locale}<DesignGallery themes={s.theme} />{/key}
	{:else}
		<p class="hint">
			Tippen hakt in der jeweiligen Vorschau ab. Mengen und Entfernen im Detail funktionieren lokal;
			Zurücksetzen stellt die Beispiele wieder her. Name und Info öffnen die vollständigen
			Testdaten.
		</p>
		{#key `${s.locale}-${s.content}-${s.state}-${s.kind}-${revision}-${s.density.join()}-${s.scale}`}
			{#each s.theme as panelTheme (panelTheme)}
				{#each s.density as panelDensity (panelDensity)}
					<section
						class="comparison"
						data-theme={panelTheme}
						aria-label={`${themeLabels[panelTheme]} · ${densityLabels[panelDensity]}`}
					>
						<h2>
							{themeLabels[panelTheme]} · {densityLabels[panelDensity]} · {s.width}px · Text {s.scale}%
						</h2>
						{#each versions as version (version.id)}
							<section class="version" data-variant={version.id}>
								<header class="version-head">
									<h3>{version.title}</h3>
									<p>{version.note}</p>
									{#if 'decision' in version}<p>Offen · [{version.decision}]</p>{/if}
								</header>
								<!-- Keyboard focus lets users scroll this comparison with arrow keys. -->
								<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
								<div
									class="panels"
									tabindex="0"
									role="region"
									aria-label={`${version.title}: Vorschauen nebeneinander`}
								>
									{#each views as view (view)}
										<section
											class="panel"
											class:dark={panelTheme === 'dark'}
											data-density={panelDensity}
											aria-label={`${version.title} · ${viewLabels[view]}`}
										>
											<h4>{viewLabels[view]}</h4>
											<!-- Each preview is an independently keyboard-scrollable region. -->
											<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
											<div
												class="frame w-(--frame-w)"
												data-view={view}
												lang={s.locale}
												style:--frame-w={`${s.width}px`}
												tabindex="0"
												role="region"
												aria-label={`${version.title} · ${viewLabels[view]} – Listeninhalt`}
											>
												<GalleryPreview
													initial={examples}
													{view}
													density={panelDensity}
													sort={itemSortOrDefault(s.order === 'default' ? null : s.order)}
													loading={s.state === 'loading'}
													captions={s.captions}
													inspect={(item, remove) => (selected = { item, remove })}
												/>
											</div>
										</section>
									{/each}
								</div>
							</section>
						{/each}
					</section>
				{/each}
			{/each}
		{/key}

		<p class="hint">
			Vorschau der Listeninhalte. Anmeldung, Synchronisierung, Kamera und Bildschirmtastatur werden
			hier nicht simuliert. Die Produktbilder sind lokale Testgrafiken.
		</p>
	{/if}
</div>

{#snippet fixtureHeaderActions()}
	{#if selected?.remove}
		<RemoveItemButton
			name={selected.item.name}
			onremove={() => {
				selected?.remove?.();
				selected = null;
			}}
		/>
	{/if}
{/snippet}

<Sheet
	open={selected !== null}
	title="Testdaten · Galerie"
	onclose={() => (selected = null)}
	headerActions={fixtureHeaderActions}
>
	{#if selected}
		<div class="fixture-details">
			<h2 dir="auto">{selected.item.name}</h2>
			{#if selected.item.quantity}<p dir="auto">{selected.item.quantity}</p>{/if}
			{#if selected.item.note}<p dir="auto">{selected.item.note}</p>{/if}
			{#if selected.item.barcode}<code>{selected.item.barcode}</code>{/if}
		</div>
	{/if}
</Sheet>

<style>
	/* Gallery chrome only. A proposal's delta lives in comparisons/<id>.css. */
	:global(.app-shell):has(.gallery) {
		max-inline-size: none;
	}
	.gallery {
		width: 100%;
		padding: 0 20px 32px;
		color: var(--foreground);
		background: var(--background);
	}
	.toolbar {
		margin-inline: -20px;
		padding: 16px 20px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	h1 {
		font-size: 1.125rem;
		font-weight: 700;
	}
	.toolbar p,
	.hint {
		max-width: 95ch;
		font-size: 0.8125rem;
		color: var(--muted-foreground);
	}
	.toolbar p {
		margin-block: 4px 16px;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 12px 16px;
	}
	.controls > div {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 4px;
		min-width: 0;
		max-width: 100%;
	}
	.controls label {
		font-size: 0.75rem;
		font-weight: 600;
	}
	select {
		min-width: 0;
		min-height: 44px;
		max-width: 100%;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--foreground);
		font-size: 1rem;
	}
	fieldset {
		display: flex;
		flex-wrap: wrap;
		gap: 0 12px;
		min-width: 0;
	}
	legend {
		font-size: 0.75rem;
		font-weight: 600;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
	}
	.options {
		margin-top: 12px;
	}
	.options summary {
		width: fit-content;
		min-height: 44px;
		align-content: center;
		cursor: pointer;
		color: var(--primary);
		font-size: 0.8125rem;
	}
	.hint {
		margin-block: 16px;
	}
	.comparison {
		margin-block: 20px 28px;
	}
	.comparison > h2 {
		margin-bottom: 14px;
		font-size: 0.875rem;
		font-weight: 600;
	}
	.version + .version {
		margin-top: 22px;
		padding-top: 22px;
		border-top: 1px solid var(--border);
	}
	.version-head {
		display: flex;
		align-items: baseline;
		gap: 8px 12px;
		flex-wrap: wrap;
		margin: 0 4px 6px;
	}
	.version-head h3 {
		font-size: 1rem;
		font-weight: 700;
	}
	.version-head p {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.panels {
		display: flex;
		align-items: start;
		gap: 20px;
		overflow-x: auto;
		padding: 4px 4px 12px;
	}
	.panel {
		flex: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		overflow: hidden;
		color: var(--foreground);
		background: var(--surface);
	}
	.panel > h4 {
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.frame {
		height: 620px;
		overflow: auto;
		/* Match the app's html viewport, including space for classic scrollbars. */
		scrollbar-gutter: stable;
		background: var(--background);
		--addbar-h: 0px;
	}
	.fixture-details {
		display: grid;
		gap: 12px;
		overflow-wrap: anywhere;
	}
	.outlines :global(.tile-text),
	.outlines :global(.row-name) {
		outline: 1px dashed var(--primary);
	}
	.outlines :global(.qty),
	.outlines :global(.tile-info),
	.outlines :global(.tile-lead) {
		outline: 1px dashed var(--danger);
	}
</style>
