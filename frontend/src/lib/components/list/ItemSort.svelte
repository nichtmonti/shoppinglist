<!-- The app bar's item order, shared by both list views and the
     previous-items screen ([D-115], §6.10). The history screen adds its date
     order but deliberately keeps a separate preference. Icons: [D-115]. -->
<script lang="ts">
	import SortMenu from '#lib/components/common/SortMenu.svelte';
	import { historySort, itemSort, uiDensity } from '#lib/state/prefs.js';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
	import List from '@lucide/svelte/icons/list';
	import { itemSortOrDefault } from '#lib/sorting.js';
	import { t } from '#lib/i18n/index.js';
	import ArrowDownAZ from '@lucide/svelte/icons/arrow-down-a-z';
	import ArrowDownGroups from '#lib/components/common/icons/ArrowDownGroups.svelte';
	import ArrowDownClock from '#lib/components/common/icons/ArrowDownClock.svelte';

	interface Props {
		history?: boolean;
		/** In the shopping view, the tiles' density too ([D-271]). */
		density?: boolean;
	}

	let { history = false, density = false }: Props = $props();

	let densityGroup = $derived(
		density
			? {
					heading: t('list_sort_heading'),
					label: t('list_display_heading'),
					value: $uiDensity,
					options: [
						{ value: 'comfortable', label: t('density_comfortable'), icon: LayoutGrid },
						{ value: 'compact', label: t('density_compact'), icon: Grid3x3 },
						{ value: 'list', label: t('density_list'), icon: List }
					],
					onselect: (v: string) => {
						if (v !== 'comfortable' && v !== 'compact' && v !== 'list') return;
						// „Liste“ has no aisle headers, so it opens in aisle order;
						// A–Z stays one choice away ([D-329]).
						if (v === 'list' && $uiDensity !== 'list') void itemSort.set('category');
						void uiDensity.set(v);
					}
				}
			: undefined
	);

	let options = $derived([
		...(history
			? [{ value: 'recent', label: t('history_sort_recent'), icon: ArrowDownClock }]
			: []),
		{ value: 'az', label: t('list_sort_alphabetical'), icon: ArrowDownAZ },
		{ value: 'category', label: t('list_sort_category'), icon: ArrowDownGroups }
	]);
	let sort = $derived(history ? $historySort : itemSortOrDefault($itemSort));

	function select(value: string): void {
		if (history) {
			if (value === 'recent' || value === 'az' || value === 'category') {
				void historySort.set(value);
			}
			return;
		}
		if (value === 'az' || value === 'category') void itemSort.set(value);
	}
</script>

<SortMenu
	value={sort}
	{options}
	onselect={select}
	label={t('list_sort_label')}
	testid="item-sort"
	group={densityGroup}
/>
