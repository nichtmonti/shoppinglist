// A list's sub-screen as its app bar shows it ([D-323]): the title, the line
// under it when not the list's name, and the way back the bar's ‹ takes
// ([D-304]): the list, unless the screen has a step of its own (the text
// import's review goes back to its text, [D-254]), and the screen's own bar
// action, if it has one (the category editor's arrange, [D-351]).
// SubScreenTitle fills it while the screen is on screen; one list is on
// screen at a time.
import type { Snippet } from 'svelte';

export const subScreen = $state<{
	title: string | undefined;
	meta: string | undefined;
	step: (() => void) | undefined;
	action: Snippet | undefined;
}>({ title: undefined, meta: undefined, step: undefined, action: undefined });
