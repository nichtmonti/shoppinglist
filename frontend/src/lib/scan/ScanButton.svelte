<!--
  §9.2 scan → resolve → create: a decoded EAN/UPC either jumps to an existing
  item (scan-dedup) or creates one carrying `barcode` + `image_url`.

  Props (the add bar renders this):
    listId: string
    onfallback?: () => void        — no product; focus the add input instead
    onadded?: (id: string) => void — an item was created (or matched) from a scan
-->
<script lang="ts">
	import Waiting from '#lib/components/common/Waiting.svelte';
	import OverlayHead from '#lib/components/ui/OverlayHead.svelte';
	import ProductPhoto from '#lib/components/common/ProductPhoto.svelte';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import Hint from '#lib/components/common/Hint.svelte';
	import { displayName } from '#lib/item-name.js';
	import { listRememberedItems, listCategories } from '#lib/state/data.js';
	import { isOnline } from '#lib/state/online.js';
	import { findByBarcode } from '#lib/dedup.js';
	import { t } from '#lib/i18n/index.js';
	import { startCameraScan, isCameraScanSupported } from './decode';
	import { resolveScannedProduct } from './resolve';
	import { createItemFromScan } from './create-from-scan';
	import { ScanSession } from './scan-session.svelte';
	import { applyDedupHit } from '#lib/actions/items.js';
	import { Dialog, DialogContent, DialogTitle } from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		Tooltip,
		TooltipProvider,
		TooltipTrigger,
		TooltipContent
	} from '#lib/components/ui/tooltip/index.js';
	import Camera from '@lucide/svelte/icons/camera';
	import CloseButton from '#lib/components/ui/CloseButton.svelte';
	interface Props {
		listId: string;
		onfallback?: () => void;
		onadded?: (itemId: string) => void;
	}

	let props: Props = $props();

	let scanLabel = $derived(t('scan_title'));

	let video = $state<HTMLVideoElement | undefined>(undefined);
	// This overlay is deliberately a Dialog, not a Sheet: full-bleed, a live
	// <video>, and it closes itself on a successful scan.

	// Read when a scan resolves, not held: a subscription would re-read the
	// list on every change while the scanner sits unused ([D-308]).
	const rows = () => listRememberedItems(props.listId).read();
	const categories = () => listCategories(props.listId).read();

	const scan = new ScanSession({
		supported: isCameraScanSupported,
		start: startCameraScan,
		onList: async (barcode) => findByBarcode(await rows(), barcode),
		reuse: (item) => applyDedupHit(item, props.onadded),
		resolve: (barcode) => resolveScannedProduct(barcode),
		create: async (barcode, product) =>
			(await createItemFromScan(props.listId, barcode, product, await rows(), await categories()))
				.itemId,
		added: (itemId) => props.onadded?.(itemId),
		isOnline
	});

	// The <video> mounts once the status is 'scanning'; start the camera then.
	$effect(() => {
		if (scan.status === 'scanning' && video) scan.startCamera(video);
	});

	// Unmounting mid-scan stops the camera and disowns whatever is in flight.
	$effect(() => () => scan.destroy());

	// Per product: a photo that failed to load is left out, with its credit.
	let photoFailed = $derived.by(() => {
		void scan.foundProduct;
		return false;
	});
</script>

<TooltipProvider>
	<Tooltip>
		<TooltipTrigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon"
					type="button"
					class="scan-trigger"
					data-testid="scan-trigger"
					onclick={() => scan.open()}
					aria-label={scanLabel}
				>
					<Camera class="shrink-0" />
				</Button>
			{/snippet}
		</TooltipTrigger>
		<TooltipContent side="bottom" sideOffset={6}>
			{scanLabel}
		</TooltipContent>
	</Tooltip>
</TooltipProvider>

<Dialog
	open={scan.status !== 'idle'}
	onOpenChange={(o) => {
		if (!o) scan.close();
	}}
>
	<DialogContent
		onCloseAutoFocus={(event) => {
			if (!scan.takeFallback()) return;
			event.preventDefault();
			props.onfallback?.();
		}}
	>
		<!-- The dialog's card, with a sheet's head and ✕ ([D-314], [D-327]). -->
		<OverlayHead>
			{#snippet title()}<DialogTitle>{t('scan_title')}</DialogTitle>{/snippet}
			{#snippet close()}<CloseButton onclick={scan.close} label={t('scan_close')} />{/snippet}
		</OverlayHead>
		{#if scan.status === 'looking_up'}
			<Waiting title={t('scan_looking_up')} data-testid="scan-message" />
		{:else if scan.status === 'not_found' || scan.status === 'offline_miss'}
			<!-- A miss is no one's error: the empty state's quiet look ([D-324]). -->
			<EmptyState title={t(scan.message!)} data-testid="scan-message" />
		{:else if scan.message}
			<ErrorText size="sm" class="py-2 text-center" data-testid="scan-message">
				{t(scan.message)}
			</ErrorText>
		{:else if scan.status === 'found' && scan.foundProduct}
			<div class="flex flex-col items-center gap-1.5">
				<ProductPhoto
					url={scan.foundProduct.image_url}
					name={displayName(scan.foundProduct)}
					failed={photoFailed}
					onerror={() => (photoFailed = true)}
					class="h-40"
				/>
				<p class="text-center text-foreground text-sm py-2" data-testid="scan-message">
					{displayName(scan.foundProduct)}
				</p>
			</div>
		{:else}
			<video
				bind:this={video}
				class="w-full h-65 object-cover rounded-card bg-black"
				muted
				playsinline
				autoplay
			></video>
			<Hint class="text-center">{t('scan_hint')}</Hint>
		{/if}
	</DialogContent>
</Dialog>
