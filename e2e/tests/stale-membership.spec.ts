// A list left and re-joined on another device has a new membership row. The
// old one must not survive a sync: two rows for one list blanked the home.
import { expect, test } from './fixtures';
import { createList, registerAccount, storeCount } from './helpers';

test('a sync drops a stale second membership for a list', async ({ page }) => {
	await registerAccount(page, 'Doppelt');
	await createList(page, 'Wocheneinkauf');
	await page.goto('/');
	await expect(page.getByRole('link', { name: /Wocheneinkauf/ })).toHaveCount(1);

	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('einkaufsliste_sync');
				req.onerror = () => reject(req.error);
				req.onsuccess = () => {
					const db = req.result;
					const store = db.transaction('memberships', 'readwrite').objectStore('memberships');
					const all = store.getAll();
					all.onsuccess = () => {
						store.put({ ...all.result[0], id: 'stalemember001' });
						store.transaction.oncomplete = () => {
							db.close();
							resolve();
						};
					};
				};
			})
	);
	await page.reload();

	await expect.poll(() => storeCount(page, 'memberships'), { timeout: 15_000 }).toBe(1);
	await page.reload();
	await expect(page.getByRole('link', { name: /Wocheneinkauf/ })).toHaveCount(1);
});
