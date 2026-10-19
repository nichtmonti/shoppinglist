<!--
  The design system as a living reference ([D-314]), beside the buttons page
  ([D-312]). The roles, ramp, radii, elevations and colours are read from
  app.css, and where each is used from the source, so a new token shows up
  here and an unused one is marked. The fields are the production parts.
-->
<script lang="ts">
	import css from '../../../app.css?raw';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { t } from '#lib/i18n/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { cardSurface, floatSurface } from '#lib/components/ui/card/card-surface.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import CloseButton from '#lib/components/ui/CloseButton.svelte';
	import { Field, FieldLabel } from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { Theme } from './axes';
	import type { Use } from './button-uses';
	import { classUses, readTokens } from './design-tokens';

	let { themes }: { themes: Theme[] } = $props();

	const tokens = readTokens(css);
	const WEIGHTS = [
		['normal', 'Fließtext'],
		['book', 'Ein Artikelname'],
		['demi', 'Beschriftungen, Schaltflächen, Zeilentitel'],
		['bold', 'Titel und Rollen']
	];
	const ICONS = [
		['size-3.5', '14px: in einer kleinen Zeile'],
		['size-4', '16px: neben Text; in jeder Schaltfläche'],
		['size-4.5', '18px: im ✕ und im Eingabefeld'],
		['size-5', '20px: Griffe und das Wischen'],
		['size-5.5', '22px: in der App-Leiste']
	];
	const RADII: Record<string, string> = {
		chip: 'in einer Zeile oder einem Bedienelement',
		control: 'was man drückt oder in das man schreibt',
		card: 'eine Fläche oder ein Bild'
	};
	const LAYERS: Record<string, string> = {
		'layer-sticky': 'eine Gangüberschrift, unter der Leiste festgehalten',
		'layer-bar': 'die Eingabeleiste und ein festgehaltener Fuß',
		'layer-modal': 'was über der Seite liegt: Abdunklung, Blätter, Dialoge, Menüs, Tooltips'
	};
	const SURFACES = [
		['cardSurface', cardSurface, 'Karte: liegt auf der Seite, auch der Installieren-Hinweis'],
		['floatSurface', floatSurface, 'Schwebend: Menü, Vorschläge, Dialog']
	];
	/** The colours by family, in app.css's order. */
	const FAMILIES: [string, (name: string) => boolean][] = [
		['Neutral', (c) => !/^(?:primary|amber|danger|tint)/.test(c)],
		['Grün', (c) => c.startsWith('primary')],
		['Bernstein', (c) => c.startsWith('amber')],
		['Rot', (c) => c.startsWith('danger')],
		['Graue Füllungen', (c) => c.startsWith('tint')]
	];
	const colourClasses = tokens.colors.flatMap(({ name: c }) => [
		`bg-${c}`,
		`text-${c}`,
		`border-${c}`,
		`--color-${c}`
	]);
	const uses = classUses([
		...tokens.roles.map((r) => r.name),
		...tokens.sizes.flatMap((s) => [`text-${s}`, `--text-${s}`]),
		...WEIGHTS.map(([w]) => `font-${w}`),
		...tokens.radii.map((r) => `rounded-${r}`),
		...tokens.shadows.map((s) => `shadow-${s}`),
		...SURFACES.map(([name]) => name),
		...tokens.layers.map((l) => `z-(--${l.name})`),
		'Card',
		...colourClasses
	]);
	/** Each line once, though a colour may be its bg-, text- and border- there. */
	const used = (...classes: string[]): Use[] => [
		...new Map(
			classes.flatMap((c) => uses.get(c) ?? []).map((u) => [`${u.file}:${u.line}`, u])
		).values()
	];
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

<div class="design-page">
	<section class="rules">
		<h2>Regeln</h2>
		<ul>
			<li>
				Schrift kommt von der Rampe in <code>app.css</code>, in vier Gewichten. Was mehr ist als
				Größe und Gewicht, Laufweite und Versalien, ist eine Rolle (<code>type-…</code>); der Lint
				verweigert <code>tracking-*</code> und <code>uppercase</code> sonst ([D-314]).
			</li>
			<li>
				Radien, Schatten und Farben sind die Tokens unten. Tailwinds eigene Stufen, Farbpaletten und
				Farbwerte im Markup verweigert der Lint (<code>eslint.shared.config.js</code>, [D-314]).
			</li>
			<li>
				Eine Farbe hat einen Namen. Jeder Ton (Grün, Bernstein, Rot) hat sich selbst, einen
				<code>-soft</code>-Grund und eine <code>-line</code>-Kante; graue Füllungen sind
				<code>tint</code> und <code>tint-strong</code>. shadcns Namen und Deckkraft an einer Farbe
				verweigert der Lint ([D-316]).
			</li>
			<li>
				Drei Radien: <code>chip</code> in einer Zeile, <code>control</code> für was man drückt oder
				beschreibt, <code>card</code> für Flächen und Bilder. Zwei Flächen: die Karte auf der Seite, das
				Schwebende darüber ([D-316]).
			</li>
			<li>
				Die Seite hat drei benannte Ebenen (unten). Ein Teil mit eigenen Ebenen versiegelt sie (<code
					>isolate</code
				>) und zählt innen 1–3; eine nackte Zahl darüber verweigert der Lint ([D-317]).
			</li>
			<li>
				Die Teile in <code>components/ui</code> tragen das Aussehen der App selbst; ein Aufrufer
				setzt Lage und Abstand, nicht das Aussehen. Felder sind <code>Input</code>,
				<code>Textarea</code>, <code>NativeSelect</code>, <code>Checkbox</code> ([D-311], [D-314]).
			</li>
			<li>
				Fokus ist eine Linie: 2px in <code>--primary-text</code>, 2px vom Rand, auf jedem
				Bedienelement, jeder Zeile und Kachel. Eine Zeile über die ganze Spalte zeichnet sie innen (<code
					>focus-visible:-outline-offset-2</code
				>); eigene Ringe verweigert der Lint ([D-315]).
			</li>
			<li>
				Abstände liegen auf einem 2px-Raster: ganze oder halbe Tailwind-Stufen, <code>px</code> nur für
				einen optischen 1px-Versatz; Viertelstufen verweigert der Lint ([D-318]).
			</li>
			<li>
				Ein Symbol hat eine Größe der Skala als Klasse, oder die der Schaltfläche, in der es steht
				([D-314]).
			</li>
		</ul>
	</section>

	{#each themes as theme (theme)}
		<section class="theme-block" data-theme={theme} class:dark={theme === 'dark'}>
			<h2>Schrift · {theme === 'dark' ? 'Dunkel' : 'Hell'}</h2>
			<div class="rows">
				{#each tokens.roles as role (role.name)}
					<div class="row">
						<div class="head">
							<code>{role.name}</code>
							<p>{role.purpose}</p>
							<p class="recipe">{role.recipe}</p>
							{@render useList(used(role.name))}
						</div>
						<p class={role.name}>Wocheneinkauf am Samstag</p>
					</div>
				{/each}
				{#each tokens.sizes as size (size)}
					<div class="row">
						<div class="head">
							<code>text-{size}</code>
							{@render useList(used(`text-${size}`, `--text-${size}`))}
						</div>
						<p class="text-{size}">Milch, 2 Liter, die mit dem blauen Deckel</p>
					</div>
				{/each}
				{#each WEIGHTS as [weight, purpose] (weight)}
					<div class="row">
						<div class="head">
							<code>font-{weight}</code>
							<p>{purpose}</p>
							{@render useList(used(`font-${weight}`))}
						</div>
						<p class="text-base font-{weight}">Haferflocken</p>
					</div>
				{/each}
			</div>

			<h2>Radien und Höhe</h2>
			<div class="swatches">
				{#each tokens.radii as radius (radius)}
					<figure>
						<div class="box rounded-{radius}"></div>
						<figcaption>
							<code>rounded-{radius}</code>
							{RADII[radius] ?? ''}
							{@render useList(used(`rounded-${radius}`))}
						</figcaption>
					</figure>
				{/each}
				{#each tokens.shadows as shadow (shadow)}
					<figure>
						<div class="box rounded-card shadow-{shadow}"></div>
						<figcaption>
							<code>shadow-{shadow}</code>
							{@render useList(used(`shadow-${shadow}`))}
						</figcaption>
					</figure>
				{/each}
			</div>

			<h2>Flächen</h2>
			<div class="swatches">
				{#each SURFACES as [name, classes, purpose] (name)}
					<figure>
						<div class={['surface', classes]}></div>
						<figcaption>
							<code>{name}</code>
							{purpose}
							{@render useList(used(name, ...(name === 'cardSurface' ? ['Card'] : [])))}
						</figcaption>
					</figure>
				{/each}
			</div>

			<h2>Ebenen</h2>
			<div class="rows">
				{#each tokens.layers as layer (layer.name)}
					<div class="row">
						<div class="head">
							<code>z-(--{layer.name})</code>
							{@render useList(used(`z-(--${layer.name})`))}
						</div>
						<p>{layer.value}: {LAYERS[layer.name] ?? ''}</p>
					</div>
				{/each}
			</div>

			<h2>Farben</h2>
			{#each FAMILIES as [family, member] (family)}
				<h3>{family}</h3>
				<div class="swatches">
					{#each tokens.colors.filter((c) => member(c.name)) as { name: colour, value } (colour)}
						<figure>
							<div class="box rounded-chip bg-(--swatch)" style:--swatch={value}></div>
							<figcaption>
								<code>{colour}</code>
								{@render useList(
									used(`bg-${colour}`, `text-${colour}`, `border-${colour}`, `--color-${colour}`)
								)}
							</figcaption>
						</figure>
					{/each}
				</div>
			{/each}

			<h2>Symbole</h2>
			<div class="swatches">
				{#each ICONS as [size, purpose] (size)}
					<figure>
						<Pencil class={size} />
						<figcaption><code>{size}</code> {purpose}</figcaption>
					</figure>
				{/each}
			</div>

			<h2>Felder und kleine Teile</h2>
			<div class="frame">
				<Field>
					<FieldLabel for="design-name-{theme}">{t('import_new_name')}</FieldLabel>
					<Input id="design-name-{theme}" placeholder="z. B. Wochenende" />
				</Field>
				<Field>
					<FieldLabel for="design-target-{theme}">{t('import_target')}</FieldLabel>
					<NativeSelect id="design-target-{theme}">
						<option>{t('import_target_new')}</option>
						<option>Wocheneinkauf</option>
					</NativeSelect>
				</Field>
				<Field>
					<FieldLabel for="design-text-{theme}">{t('import_paste_label')}</FieldLabel>
					<Textarea id="design-text-{theme}" class="min-h-24" placeholder="Milch" />
				</Field>
				<div class="flex items-center gap-4">
					<Checkbox checked aria-label="Milch" />
					<Checkbox aria-label="Brot" />
					<Checkbox checked disabled aria-label="Butter" />
					<Badge class="text-amber border-amber-line bg-amber-soft">2 offen</Badge>
					<CloseButton />
				</div>
			</div>
		</section>
	{/each}
</div>

<style>
	.design-page {
		display: grid;
		gap: 28px;
		padding-block: 20px;
	}
	h2 {
		margin-bottom: 12px;
		font-size: 0.9375rem;
		font-weight: 700;
	}
	.rules ul {
		display: grid;
		gap: 4px;
		max-width: 80ch;
		padding-left: 18px;
		list-style: disc;
		font-size: 0.8125rem;
		color: var(--muted-foreground);
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
	.rows {
		display: grid;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(200px, 320px) 1fr;
		gap: 16px;
		align-items: center;
		padding-block: 10px;
		border-top: 1px solid var(--border);
	}
	.head p {
		font-size: 0.8125rem;
		color: var(--muted-foreground);
	}
	.recipe {
		font: 0.6875rem/1.5 var(--font-num);
	}
	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 16px 20px;
	}
	figure {
		display: grid;
		justify-items: start;
		gap: 6px;
		max-width: 160px;
		margin: 0;
	}
	figcaption {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	h3 {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--muted-foreground);
	}
	.surface {
		width: 140px;
		height: 72px;
	}
	.box {
		width: 72px;
		height: 48px;
		border: 1px solid var(--line-strong);
		background: var(--surface);
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
	.frame {
		display: grid;
		gap: 14px;
		max-width: 390px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface);
	}
</style>
