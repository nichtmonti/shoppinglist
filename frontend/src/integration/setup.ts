// Per-file setup for the integration project.
//
// The client's sync modules fetch RELATIVE urls ('/api/sync/push'), because in
// the shipped app the SPA is served same-origin by PocketBase itself and
// passkeys require staying on one origin (see src/lib/pb.ts). Node has no
// document origin to resolve against, so the harness supplies one. This is the
// suite's ONLY shim — every request below it hits the real binary.
import { BASE_URL } from './config';

const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	if (typeof input === 'string' && input.startsWith('/')) {
		return realFetch(BASE_URL + input, init);
	}
	return realFetch(input, init);
};
