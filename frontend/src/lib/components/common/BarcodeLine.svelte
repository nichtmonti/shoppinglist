<!--
  A scanned item's barcode in an item sheet, with a copy-to-clipboard action.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let { barcode, class: className }: { barcode: string; class?: string } = $props();

	function copy(): void {
		void navigator.clipboard?.writeText(barcode);
	}
</script>

<div class={cn('barcode-line flex items-center gap-2.5 justify-between', className)}>
	<code>{barcode}</code>
	<!-- The same secondary as the share sheet's „Kopieren“ ([D-311]). -->
	<Button variant="outline" size="sm" onclick={copy}>{t('shop_copy_barcode')}</Button>
</div>
