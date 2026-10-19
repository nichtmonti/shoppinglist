// `#demo` in the demo build ([D-234], types.ts).
import type { Demo } from './types';
import DemoStart from './DemoStart.svelte';
import DemoBanner from './DemoBanner.svelte';
import DemoSignOut from './DemoSignOut.svelte';

export const demo: Demo = {
	enabled: true,
	Start: DemoStart,
	Banner: DemoBanner,
	SignOut: DemoSignOut
};
