<script lang="ts" module>
	import { type VariantProps } from 'tailwind-variants/lite';
	import { cn, type WithElementRef, tv } from '#lib/utils.js';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	export const buttonVariants = tv({
		// One flat material for every level ([D-284]): the fields' 12px corners,
		// 650 labels, no depth, and a press that darkens the fill. Disabled is
		// the same flat grey for every level, with no edge: what an enabled
		// secondary has (a white fill and a firm edge), it lacks.
		base: "rounded-control border border-transparent bg-clip-padding text-sm font-demi [&_svg:not([class*='size-'])]:size-4 inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all select-none disabled:pointer-events-none disabled:border-transparent disabled:bg-tint-strong disabled:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				default:
					'bg-primary text-primary-foreground hover:bg-primary-press active:bg-primary-press',
				// The secondary: white, with an edge at 3:1 so it reads as a button
				// on its own, and never green: green is the primary's ([D-284]).
				outline:
					'border-faint bg-surface-2 text-foreground hover:bg-tint active:bg-tint-strong aria-expanded:bg-tint-strong',
				// Text for the rest: no fill to lose, so disabled, its words fade. It
				// presses in neutral grey, since soft green says "chosen" ([D-281]).
				ghost:
					'hover:bg-tint active:bg-tint-strong aria-expanded:bg-tint-strong disabled:bg-transparent',
				// An icon that is a row's or a sheet's tool, not its point: grey at
				// rest, the chip fill on a press ([D-282]).
				quiet:
					'text-muted-foreground hover:bg-tint-strong hover:text-foreground active:bg-tint-strong active:text-foreground disabled:bg-transparent',
				// The red word ([D-280]): a rare act that can be redone, quieter
				// than either destructive fill.
				'ghost-destructive':
					'text-danger hover:bg-danger-soft active:bg-danger-soft disabled:bg-transparent',
				// Two destructive strengths ([D-214]): the soft one for what can be
				// undone or redone (remove a passkey, leave a shared list, unlink a
				// login), the solid one for what nothing brings back (deleting the
				// account, the last member leaving a list) — so the two never look
				// alike.
				destructive: 'bg-danger-soft text-danger border border-danger-line',
				danger: 'bg-danger text-danger-foreground border border-danger'
			},
			size: {
				// One height for every text button ([D-312]); `sm` sits inside a
				// row or a field.
				default: 'h-11 gap-1.5 px-2.5',
				sm: "h-9 gap-1 px-2.5 text-meta [&_svg:not([class*='size-'])]:size-3.5 relative after:absolute after:inset-[-4px] after:content-['']",
				// 40px painted, 48px tappable (WCAG 2.5.5) — the app's tap-target
				// idiom across the whole scale ([D-56]); 40px painted ≥ 24px rule.
				icon: "relative size-10 rounded-control after:absolute after:inset-[-4px] after:content-['']",
				// 30px painted, 44px to tap ([D-56]): a row's icon tools.
				'icon-sm': 'relative size-7.5 rounded-chip hit-target'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> & {
		variant?: ButtonVariant;
		size?: ButtonSize;
	};
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		type = 'button',
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

<button
	bind:this={ref}
	data-slot="button"
	class={cn(buttonVariants({ variant, size }), className)}
	{type}
	{disabled}
	{...restProps}
>
	{@render children?.()}
</button>
