// The app's text field ([D-314]): the one look an Input, a Textarea and a
// NativeSelect share, at the 16px iOS no-zoom floor. It was the callers' to
// add, so the import screen's textarea and select went without it. An error
// turns the edge red; disabled is the buttons' grey ([D-284]).
export const fieldClass =
	'w-full min-w-0 rounded-control border border-line-strong bg-surface-2 px-3 py-2.5 text-base transition-colors placeholder:text-muted-foreground aria-invalid:border-danger disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-transparent disabled:bg-tint-strong disabled:text-muted-foreground';
