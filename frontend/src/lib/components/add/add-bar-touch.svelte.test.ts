// [D-132] The tap that is NOT a near miss: a thumb squarely on a suggestion
// opened the detail sheet of the row behind it on an iPhone. bits-ui selects on
// pointerup, which unmounts the dropdown and the scrim before the tap's click
// is dispatched, and a touch click is hit-tested where the finger was — so it
// reached the row now under it. happy-dom cannot hit-test, so what is pinned is the
// order that makes the fall-through impossible: a touch pointerup changes
// nothing, and the click that follows it — landing on the still-mounted
// option — is what commits. The hit-testing half is in sticky-addbar.spec.ts.
//
// Its own file for one reason: it has to run AS AN iPHONE. bits-ui already
// defers a touch pick to the click everywhere except where its user-agent
// sniff says iOS, and it takes that sniff once, at module load. Under happy-dom's
// own user agent these tests pass against the unfixed component (watched), so
// the stub below must land before bits-ui is first imported — which a
// per-file module graph guarantees and a shared file with 30 other tests
// could not without running them all as an iPhone too.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	Object.defineProperty(window.navigator, 'userAgent', {
		configurable: true,
		value:
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
	});
});

// The add box renders the real ScanButton; happy-dom has no camera or WASM decode
// (same stub as add-bar.svelte.test.ts).
vi.mock('#lib/scan/decode.js', async () => {
	const actual = await vi.importActual<typeof import('#lib/scan/decode.js')>('#lib/scan/decode.js');
	return {
		...actual,
		isCameraScanSupported: vi.fn(() => true),
		startCameraScan: vi.fn(() => ({ result: Promise.resolve(''), stop: vi.fn() }))
	};
});

import { db, type ItemDictionary } from '#lib/db.js';
import { resetDb, seedList } from '#lib/test-kit/db.js';
import { t } from '#lib/i18n/index.js';
import AddBar from './AddBar.svelte';

const LIST_ID = 'list-1';

function dict(overrides: Partial<ItemDictionary> & { id: string }): ItemDictionary {
	return {
		names_i18n: { de: ['Gurke'], en: ['Cucumber'] },
		default_category: null,
		popularity: 1,
		...overrides
	};
}

async function renderBar() {
	render(AddBar, { listId: LIST_ID, onjump: vi.fn() });
	return { input: await screen.findByRole('combobox', { name: t('add_label') }) };
}

async function openAndType(input: HTMLElement, value: string): Promise<void> {
	await fireEvent.keyDown(input, { key: 'x' });
	await fireEvent.input(input, { target: { value } });
}

beforeEach(async () => {
	await resetDb();
});

describe('AddBar on iOS — a touch tap commits on its click, so it cannot fall through ([D-132])', () => {
	it('runs as an iPhone, or it proves nothing', () => {
		expect(navigator.userAgent).toMatch(/iPhone/);
	});

	it('leaves the dropdown up through a touch pointerup, and picks on the click', async () => {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.bulkPut([
			dict({ id: 'item_milch', names_i18n: { de: ['Milch'], en: ['Milk'] }, popularity: 9 })
		]);
		const { input } = await renderBar();
		await openAndType(input, 'Mil');
		const option = await waitFor(() => {
			const el = document.querySelector('[data-ta-name="Milch"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});

		await fireEvent.pointerUp(option, { pointerType: 'touch' });
		await new Promise((r) => setTimeout(r, 30));
		expect(document.querySelector('[data-ta-name="Milch"]')).not.toBeNull();
		expect(screen.queryByTestId('ta-scrim')).not.toBeNull();
		expect(await db.items.where('list').equals(LIST_ID).count()).toBe(0);

		await fireEvent.click(option);
		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.map((r) => r.name)).toEqual(['Milch']);
		});
		await waitFor(() => expect(document.querySelector('[role="option"]')).toBeNull());
	});

	it('takes the as-typed row the same way', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Klebeband');
		const addRow = await waitFor(() => {
			const el = document.querySelector('[data-ta-add="Klebeband"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});

		await fireEvent.pointerUp(addRow, { pointerType: 'touch' });
		await new Promise((r) => setTimeout(r, 30));
		expect(await db.items.where('list').equals(LIST_ID).count()).toBe(0);

		await fireEvent.click(addRow);
		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.map((r) => r.name)).toEqual(['Klebeband']);
		});
	});
});
