// The card a dialog or a confirmation is ([D-311], [D-327]): centred, 16px in
// from the screen's edges and padded 16px like a sheet, its blocks 16px
// apart, never taller than the screen (a long one scrolls inside).
export const dialogSurface =
	'fixed top-1/2 left-1/2 z-(--layer-modal) grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-1/2 gap-4 overflow-y-auto p-4 text-sm text-foreground outline-none duration-100 sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95';
