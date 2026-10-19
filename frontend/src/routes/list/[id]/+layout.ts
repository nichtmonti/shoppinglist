// The list's data is read before the screen renders, so it appears whole
// instead of filling in ([D-205]).
import { preloadList } from '#lib/state/data.js';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ params }) => {
	await preloadList(params.id);
};
