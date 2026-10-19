// The shop view's "+ (zur Liste)" jumps to the list view with the add box
// focused (§9.1). The two components are independent, so the handoff is a
// one-shot flag rather than a prop drilled through the route: the shop view
// sets it before switching, the add box clears it once it has taken focus.
import { writable } from 'svelte/store';

export const addFocusRequested = writable(false);
