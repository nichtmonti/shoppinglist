<!--
  §9.3's ordering picker: the in-list bar's SortMenu with the home's options.
  Every option's icon carries lucide's sort arrow in the same position beside
  the mode's own mark ([D-115]; activity's is in #lib/components/common/icons).
  "Reihenfolge ändern …" enters arranging ([D-90]); its icon is the grip,
  since it opens the place where you drag. Offered only with two lists or more.
-->
<script lang="ts">
	import SortMenu from '#lib/components/common/SortMenu.svelte';
	import { listSort } from '#lib/state/prefs.js';
	import { t } from '#lib/i18n/index.js';
	import ArrowDownAZ from '@lucide/svelte/icons/arrow-down-a-z';
	import ArrowDownClock from '#lib/components/common/icons/ArrowDownClock.svelte';
	import ArrowDownUp from '@lucide/svelte/icons/arrow-down-up';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';

	let { onarrange }: { onarrange?: () => void } = $props();

	let options = $derived([
		{ value: 'activity', label: t('home_sort_activity'), icon: ArrowDownClock },
		{ value: 'alphabetical', label: t('list_sort_alphabetical'), icon: ArrowDownAZ },
		{ value: 'custom', label: t('home_sort_custom'), icon: ArrowDownUp }
	]);

	function select(value: string): void {
		if (value === 'activity' || value === 'alphabetical' || value === 'custom') {
			void listSort.set(value);
		}
	}
</script>

<SortMenu
	value={$listSort}
	{options}
	onselect={select}
	label={t('home_sort_label')}
	testid="list-sort"
	action={onarrange && {
		label: t('home_arrange'),
		icon: GripVertical,
		onselect: onarrange
	}}
/>
