// The row every menu entry shares: 44px tall, the [D-56] floor. Its label
// and leading icon look like a list ⋮ sheet's row: 550, a 20px grey icon
// 12px from the label; the icon takes the entry's colour when it is
// highlighted, chosen or red ([D-322]).
export const itemClass =
	"relative flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 py-2 text-sm font-book outline-hidden select-none data-highlighted:bg-primary-soft data-highlighted:text-primary-text data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5 [&>svg:first-child]:text-muted-foreground data-highlighted:[&>svg]:text-current data-[state=checked]:[&>svg]:text-current data-[variant=destructive]:[&>svg]:text-current";
