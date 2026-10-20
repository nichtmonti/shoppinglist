// [D-213] Another device's check-off slides the next tile into the slot under
// a finger on its way down: a tap that lands on that tile while it is still
// arriving was aimed at the one that left, so it ticks nothing. Once the tile
// has settled, a tap ticks it as ever.
import { expect, test } from './fixtures';
import {
	addItemByTyping,
	chooseItemSort,
	createList,
	openListView,
	openSameAccountDevice,
	openShopView,
	registerAccount
} from './helpers';

test("a tap on a tile another device's tick just slid into place ticks nothing", async ({
	page,
	browser
}) => {
	await registerAccount(page, 'Tara');
	const listUrl = await createList(page, 'Markt');
	await openListView(page);
	for (const name of ['Apfel', 'Brot', 'Butter']) await addItemByTyping(page, name);
	await chooseItemSort(page, 'az');
	await openShopView(page);

	const other = await openSameAccountDevice(browser, page);
	await other.page.goto(listUrl);
	await chooseItemSort(other.page, 'az');
	await openShopView(other.page);

	const apple = page.getByRole('button', { name: 'Apfel, abhaken' });
	const bread = page.getByRole('button', { name: 'Brot, abhaken' });
	const slot = (await apple.boundingBox())!;

	await other.page.getByRole('button', { name: 'Apfel, abhaken' }).click();
	// Every frame, so the tap follows the slide as closely as a finger would.
	await page.waitForFunction(() => !document.querySelector('[aria-label="Apfel, abhaken"]'), null, {
		polling: 'raf'
	});
	// Late in the slide, once the tile is drawn (nearly) in the slot: at its
	// start the flip still draws it where it was. Watched every frame, not
	// timed, so a slow machine neither taps too early (and misses it) nor too
	// late (past the guard).
	await page.waitForFunction(
		({ x, y }) => {
			const r = document.querySelector('[aria-label="Brot, abhaken"]')?.getBoundingClientRect();
			return !!r && Math.abs(r.x - x) < 4 && Math.abs(r.y - y) < 4;
		},
		{ x: slot.x, y: slot.y },
		{ polling: 'raf' }
	);
	await page.mouse.click(slot.x + slot.width / 2, slot.y + slot.height / 2);

	await page.waitForTimeout(1000);
	await expect(bread).toBeVisible();

	// Settled, the same tap ticks it.
	await page.mouse.click(slot.x + slot.width / 2, slot.y + slot.height / 2);
	await expect(bread).toHaveCount(0);

	await other.context.close();
});
