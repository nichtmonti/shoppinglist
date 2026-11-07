<!--
  The app's one reorder surface ([D-90]): "Listen anordnen" (§9.3) and
  "Kategorien anordnen" (§6.7). A mode left with "Fertig"; rows here open and
  edit nothing.

  Each row ends in its grip. A tap selects the row, and only the selected row
  shows ↑ / ↓ ([D-237]): the single-pointer path (WCAG 2.5.7), and the one a
  screen reader's double-tap reaches. The grip is the only place a drag starts,
  so it lifts at once with no touch hold; `touch-none` keeps the browser from
  claiming it as a scroll. It is also the keyboard's drag (Space, arrows,
  Space). svelte-dnd-action's stores are module-global: one ArrangeList on
  screen at a time.

  Controls are sized in px, not rem ([D-90]): they hold icons, and at 200%
  text rem would take the name's width. A row narrow in rem moves them to a
  line of their own under the name.
-->
<script lang="ts" generics="T">
	import { tick, type Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { alertToScreenReader, dragHandle, dragHandleZone } from 'svelte-dnd-action';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import { DndList } from './dnd-list.svelte.js';
	import { dur, DND_FLIP_MS, flipNear } from '#lib/state/motion.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { cardSurface } from '#lib/components/ui/card/card-surface.js';
	import { t } from '#lib/i18n/index.js';

	interface Props {
		/** The rows in their current order — the source of truth. */
		rows: T[];
		idOf: (row: T) => string;
		/** The row's name: its controls' labels and the drag announcements. */
		labelOf: (row: T) => string;
		/** Called with the new id order after a drop or an arrow move. */
		onreorder: (ids: string[]) => void;
		/** The list's name in the drag announcements ("… in der Liste {label}"). */
		label: string;
		/** What the row shows before its controls. */
		row: Snippet<[T]>;
		/** Rows look like the home's list cards rather than ruled rows ([D-238]). */
		cards?: boolean;
		/** Where a ruled row's line starts, as RuledRows' `inset`. */
		inset?: string;
	}

	let {
		rows,
		idOf,
		labelOf,
		onreorder,
		label,
		row,
		cards = false,
		inset = 'var(--row-gutter)'
	}: Props = $props();

	function rowClass(key: string): string {
		const on = selected === key;
		if (cards) {
			return cn(cardSurface, 'py-3.5 ps-3.5 pe-2', on && 'border-primary-line bg-primary-soft');
		}
		return cn('py-1 ps-(--row-gutter) pe-2', on ? 'bg-primary-soft' : 'bg-background');
	}

	const dnd = new DndList(
		() => rows,
		(r) => idOf(r),
		(ids) => onreorder(ids)
	);

	// The row showing its arrows; a tap on its own grip clears it.
	let selected = $state<string | null>(null);

	// A tap is a click: svelte-dnd-action sends one itself when a touch on the
	// grip ends without a drag, since its touchstart cancels the browser's.
	function toggle(key: string): void {
		selected = selected === key ? null : key;
	}

	async function move(event: MouseEvent, r: T, delta: -1 | 1): Promise<void> {
		const button = event.currentTarget as HTMLButtonElement;
		const position = dnd.move(idOf(r), delta);
		if (position === null) return;
		alertToScreenReader(t('arrange_moved', { item: labelOf(r), position, count: dnd.rows.length }));
		// Moving to an end disables the pressed button; keep focus in the row.
		await tick();
		if (button.disabled) {
			button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
		}
	}
</script>

<div
	class={cn('arrange-list', cards ? 'flex flex-col gap-(--card-gap)' : 'ruled-rows')}
	style={cards ? undefined : `--rule-inset: ${inset}`}
	use:dragHandleZone={dnd.zoneOptions({})}
	onconsider={dnd.consider}
	onfinalize={dnd.finalize}
	aria-label={label}
>
	{#each dnd.rows as { key, row: r }, i (key)}
		{@const name = labelOf(r)}
		<!-- aria-label: svelte-dnd-action's announcements read the name off it.
		     Opaque background: the lifted clone is this element. The last ruled
		     row has no rule ([D-128]). -->
		<div
			class={cn(
				'arrange-row @container flex min-h-13 flex-wrap items-center gap-x-2 gap-y-1',
				rowClass(key)
			)}
			data-arrange-id={key}
			animate:flipNear={{ duration: dur(DND_FLIP_MS), easing: cubicOut }}
			aria-label={name}
		>
			<div class="min-w-0 flex-1 @max-3xs:basis-full">{@render row(r)}</div>
			<div class="ms-auto flex items-center gap-2">
				{#if selected === key}
					<Button
						variant="quiet"
						size="icon-sm"
						disabled={i === 0}
						aria-label={t('arrange_up', { name })}
						onclick={(e) => void move(e, r, -1)}
					>
						<ArrowUp class="shrink-0" />
					</Button>
					<Button
						variant="quiet"
						size="icon-sm"
						disabled={i === dnd.rows.length - 1}
						aria-label={t('arrange_down', { name })}
						onclick={(e) => void move(e, r, 1)}
					>
						<ArrowDown class="shrink-0" />
					</Button>
				{/if}
				<!-- Its keys are dragHandle's: Space or Enter starts the keyboard drag.
				     A <button> would lose both drags, which skip clickable targets.
				     The role and tabindex are the ones dragHandle sets at rest. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<span
					use:dragHandle
					role="button"
					tabindex="0"
					class="arrange-handle grid size-11 shrink-0 touch-none place-items-center rounded-control text-muted-foreground hover:text-foreground"
					aria-label={t('arrange_drag', { name })}
					aria-pressed={selected === key}
					onclick={() => toggle(key)}
				>
					<GripVertical class="size-5 shrink-0" />
				</span>
			</div>
		</div>
	{/each}
</div>
