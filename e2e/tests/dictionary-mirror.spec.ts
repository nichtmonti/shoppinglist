import { expect, test } from './fixtures';
import { registerAccount, createList, openListView } from './helpers';

const DICT_DB = 'einkaufsliste_sync';

// Regression: the dictionary mirror self-heal — a client whose local
// item_dictionary is empty while meta.seed_version stays stamped (a failed
// or empty-fetch mirror run) must re-mirror on the next session start.
// 1. Fresh client renders dictionary suggestions (baseline).
// 2. Poison: clear item_dictionary + category_templates, keep the version.
// 3. Reload → the once-per-session mirror self-heals → suggestions return.
test('dictionary mirror self-heal', async ({ page }) => {
	await page.goto('/');
	await registerAccount(page, 'DictProbe');
	const listUrl = await createList(page, 'Wochenshop');
	await openListView(page);

	const combobox = page.getByRole('combobox');
	const gurke = page.locator('[data-ta-name="Gurke"]');

	// 1. Baseline: the dictionary suggestion renders on a fresh client.
	await combobox.fill('Gur');
	await expect(gurke).toBeVisible();

	// 2. Poison the client: empty dictionary, version still stamped.
	await page.evaluate(async (dbName) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(dbName);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const clear = (store: string) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction(store, 'readwrite');
				tx.objectStore(store).clear();
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		await clear('item_dictionary');
		await clear('category_templates');
		const count = () =>
			new Promise<number>((resolve, reject) => {
				const tx = db.transaction('item_dictionary', 'readonly');
				const req = tx.objectStore('item_dictionary').count();
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		const remaining = await count();
		if (remaining !== 0) throw new Error(`expected empty dictionary, got ${remaining}`);
		db.close();
	}, DICT_DB);

	// 3. Reload: the version matches but the table is empty → self-heal re-mirrors.
	await page.reload();
	await expect
		.poll(
			async () => {
				return page.evaluate(async (dbName) => {
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const req = indexedDB.open(dbName);
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					const count = await new Promise<number>((resolve, reject) => {
						const tx = db.transaction('item_dictionary', 'readonly');
						const req = tx.objectStore('item_dictionary').count();
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					db.close();
					return count;
				}, DICT_DB);
			},
			{ timeout: 30000 }
		)
		.toBeGreaterThan(0);

	await combobox.fill('Gur');
	await expect(gurke).toBeVisible();
});
