<!--
  The "last purchased" entry in the sort menu (§9.1, [D-115]): lucide's sort
  arrow verbatim with a clock in the right-hand slot, as ArrowDownGroups.

  The numbers are constrained, not chosen. A stroke paints ±1 around its path,
  so (a) cx+r+1 must stay under 24 or the viewBox clips it, and (b) the
  arrowhead `m3 16 4 4 4-4` reaches x=12 at y=16, which a face centred at
  cy=12 hits from r≥5.75. Centred at (17,11), r=5.9 clears both. Hands follow
  lucide's clock proportions (up 0.6r, then 0.4r right and 0.2r down).
  Re-derive both constraints if r or the centre changes.
-->
<script lang="ts">
	let { size = 24, ...rest }: { size?: number | string } & Record<string, unknown> = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	{...rest}
>
	<path d="m3 16 4 4 4-4" />
	<path d="M7 20V4" />
	<circle cx="17" cy="11" r="5.9" />
	<path d="M17 7.5V11l2.4 1.2" />
</svg>
