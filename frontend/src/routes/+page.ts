// The home screen's data is read before it renders ([D-205]); see
// routes/list/[id]/+layout.ts.
import { preloadHome } from '#lib/state/data.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
	await preloadHome();
};
