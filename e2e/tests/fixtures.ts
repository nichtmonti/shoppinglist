// The browser specs' `test`: Playwright's, with every test arriving from its
// own client address ([D-223]).
//
// The server's per-IP budgets (§10: 30 passkey ceremonies a minute, 30 new
// lists per 5 minutes) are sized for a person, and every spec here runs from
// one machine: the suite registers an account and creates a list per context,
// and every auth-screen view fires a background login/begin ([D-69]). Rather
// than raising the budgets for the harness, the harness looks like what the
// budgets are for — separate people: the app server trusts X-Forwarded-For
// (server.ts), and this fixture gives each test a fresh address in it. Every
// context a test opens, `browser.newContext()` included, inherits the header,
// so the devices of one test share an address, as one household's do.
//
// A spec that imports `test` from '@playwright/test' instead runs from the
// machine's own address and shares its budgets with every other such spec.
import { test as base } from '@playwright/test';
import { guardTest } from '../diagnose';

export * from '@playwright/test';

let serial = 0;

export const test = base.extend({
	extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
		serial += 1;
		// 10.100+ per worker: e2e/oidc/dex.ts's OIDC exchanges use 10.1.
		const ip = `10.${100 + (testInfo.workerIndex % 100)}.${(serial >> 8) & 255}.${serial & 255}`;
		await use({ ...extraHTTPHeaders, 'X-Forwarded-For': ip });
	},
	// Every test's page is watched, and a failure or a looming timeout writes
	// what the page was doing to page-diagnosis.md ([D-247], ../diagnose.ts).
	page: async ({ page }, use, testInfo) => {
		const done = guardTest(page, testInfo);
		await use(page);
		await done();
	}
});
