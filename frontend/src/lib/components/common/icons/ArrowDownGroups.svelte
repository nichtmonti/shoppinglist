<!--
  The "order by category" entry in the sort menu (§9.1, [D-115]). Lucide has
  no such icon: its sort icons' subjects do not mean "category", and its
  `{object}-arrow-down` icons put the arrow elsewhere. So lucide's sort arrow,
  copied verbatim (`m3 16 4 4 4-4` + `M7 20V4`), with a heading-and-items mark
  in the right-hand slot. Keep the arrow paths byte-identical to lucide's:
  that sameness is the point of the icon.
-->
<script lang="ts">
	// A lucide icon's shape (`size`, the rest passes through), for SortMenu.
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
	<path d="M13 5h8" />
	<path d="M16 10h5" />
	<path d="M16 14h5" />
	<path d="M13 19h8" />
</svg>
