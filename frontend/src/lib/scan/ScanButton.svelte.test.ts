// Component coverage for the barcode scan feature (§9.2): the button
// states and the full scan → resolve → create pipeline, driven end-to-end
// through the real component against a real (fake-indexeddb) Dexie instance.
//
// The camera + WASM decode step (./decode.ts) needs a real camera and a real
// barcode-shaped video frame — neither exists in happy-dom — so it is mocked
// wholesale, the same pattern auth-screen.svelte.test.ts uses for #lib/auth.
// Everything downstream of "a barcode string came out of the scanner" (cache
// lookup, the OFF/OBF network call, category mapping, scan-dedup, addItem) is
// the REAL production code, exercised through the component's actual props.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./decode', () => {
	class CameraPermissionDeniedError extends Error {}
	class CameraDecodeError extends Error {}
	class CameraUnsupportedError extends Error {}
	return {
		isCameraScanSupported: vi.fn(() => true),
		startCameraScan: vi.fn(),
		CameraPermissionDeniedError,
		CameraDecodeError,
		CameraUnsupportedError
	};
});

import { db } from '#lib/db.js';
import { makeCategory, makeItem, resetDb, seedList } from '#lib/test-kit/db.js';
import {
	isCameraScanSupported,
	startCameraScan,
	CameraPermissionDeniedError,
	CameraDecodeError
} from './decode';
import { BARCODE_ENDPOINT } from './lookup';
import ScanButton from './ScanButton.svelte';

const LIST = 'list-1';
const EAN = '3017620422003';
const IMG = 'https://images.example/nutella.jpg';

function jsonResponse(body: unknown, ok = true): Response {
	return Response.json(body, { status: ok ? 200 : 404 });
}

function mockScan(barcode: string): { stop: ReturnType<typeof vi.fn> } {
	const stop = vi.fn();
	vi.mocked(startCameraScan).mockReturnValue({ result: Promise.resolve(barcode), stop });
	return { stop };
}

function mockScanRejects(error: Error): void {
	// Built lazily inside mockImplementation (not a pre-built `Promise.reject`)
	// so the rejection is created at the same moment `.then().catch()` attaches
	// to it (inside the component's effect) — an eagerly-rejected promise sitting
	// around for several ticks before anything observes it trips Node's
	// unhandled-rejection detector even though it IS handled a moment later.
	vi.mocked(startCameraScan).mockImplementation(() => ({
		result: Promise.reject(error),
		stop: vi.fn()
	}));
}

async function openScanner(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Barcode scannen' }));
}

describe('ScanButton', () => {
	beforeEach(async () => {
		await resetDb();
		vi.mocked(startCameraScan).mockReset();
		vi.mocked(isCameraScanSupported).mockReset().mockReturnValue(true);
		vi.stubGlobal('fetch', vi.fn());
	});

	it('1. a cached hit in scanned_products resolves without any network call', async () => {
		const pantry = makeCategory({ list: LIST, slug: 'pantry' });
		await seedList({ listId: LIST, categories: [pantry] });
		await db.scanned_products.put({
			barcode: EAN,
			name: 'Nutella',
			image_url: IMG,
			category_slug: 'pantry',
			looked_up_at: new Date().toISOString()
		});
		mockScan(EAN);
		const onadded = vi.fn();

		render(ScanButton, { props: { listId: LIST, onadded } });
		await openScanner();
		await waitFor(() => expect(onadded).toHaveBeenCalled());

		expect(fetch).not.toHaveBeenCalled();
		const created = await db.items.get(onadded.mock.calls[0][0] as string);
		expect(created).toMatchObject({
			name: 'Nutella',
			barcode: EAN,
			image_url: IMG,
			category_key: pantry.id
		});
	});

	it('2. a cache miss with a successful online lookup creates the item and caches the result', async () => {
		const pantry = makeCategory({ list: LIST, slug: 'pantry' });
		await seedList({ listId: LIST, categories: [pantry] });
		mockScan(EAN);
		vi.mocked(fetch).mockImplementation((url) => {
			if (url === BARCODE_ENDPOINT(EAN)) {
				return Promise.resolve(
					jsonResponse({
						name: 'Nutella',
						image_url: IMG,
						category_slug: 'pantry'
					})
				);
			}
			return Promise.resolve(jsonResponse({}, false));
		});
		const onadded = vi.fn();

		render(ScanButton, { props: { listId: LIST, onadded } });
		await openScanner();
		await waitFor(() => expect(onadded).toHaveBeenCalled());

		const created = await db.items.get(onadded.mock.calls[0][0] as string);
		expect(created).toMatchObject({
			name: 'Nutella',
			barcode: EAN,
			image_url: IMG,
			category_key: pantry.id
		});

		const cached = await db.scanned_products.get(EAN);
		expect(cached).toMatchObject({ barcode: EAN, name: 'Nutella', image_url: IMG });
	});

	it('3. a lookup miss everywhere calls onfallback and creates nothing', async () => {
		await seedList({ listId: LIST });
		mockScan(EAN);
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ status: 0 }));
		const onfallback = vi.fn();
		const onadded = vi.fn();
		const itemsBefore = await db.items.count();

		render(ScanButton, { props: { listId: LIST, onfallback, onadded } });
		await openScanner();
		await waitFor(() => expect(onfallback).toHaveBeenCalledTimes(1));

		expect(onadded).not.toHaveBeenCalled();
		expect(await db.items.count()).toBe(itemsBefore);
	});

	it('4. offline: skips the network call entirely and goes straight to fallback', async () => {
		await seedList({ listId: LIST });
		mockScan(EAN);
		const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
		const onfallback = vi.fn();

		try {
			render(ScanButton, { props: { listId: LIST, onfallback } });
			await openScanner();
			await waitFor(() => expect(onfallback).toHaveBeenCalledTimes(1));

			expect(fetch).not.toHaveBeenCalled();
		} finally {
			onLineSpy.mockRestore();
		}
	});

	it('5. scan-dedup: a barcode matching an existing item does not create a duplicate', async () => {
		const existing = makeItem({ list: LIST, name: 'Nutella (schon da)', barcode: EAN });
		await seedList({ listId: LIST, items: [existing] });
		mockScan(EAN);
		const onadded = vi.fn();
		const itemsBefore = await db.items.count();

		render(ScanButton, { props: { listId: LIST, onadded } });
		await openScanner();
		await waitFor(() => expect(onadded).toHaveBeenCalledTimes(1));

		expect(onadded).toHaveBeenCalledWith(existing.id);
		expect(fetch).not.toHaveBeenCalled();
		expect(await db.items.count()).toBe(itemsBefore);
	});

	it('5b. scan-dedup onto a CHECKED row re-activates it instead of reporting a jump', async () => {
		// §9.1 states one rule for both dedup paths — "an active match focuses the
		// existing row, a checked match re-activates it" — and #lib/dedup's header
		// says the two must never disagree. The scanner reaches it through the same
		// applyDedupHit() the typeahead uses, so this is the barcode half of the
		// behaviour add-bar.svelte.test.ts already pins for a typed name.
		const existing = makeItem({
			list: LIST,
			name: 'Nutella (abgehakt)',
			barcode: EAN,
			checked: true
		});
		await seedList({ listId: LIST, items: [existing] });
		mockScan(EAN);
		const onadded = vi.fn();

		render(ScanButton, { props: { listId: LIST, onadded } });
		await openScanner();

		await waitFor(async () => {
			expect((await db.items.get(existing.id))?.checked).toBe(false);
		});
		// Re-activating IS the reveal here — the row moves back into the active
		// list and raises its own restore toast, so there is nothing to jump to.
		expect(onadded).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('shows the unsupported-device message and calls onfallback without ever starting the camera', async () => {
		vi.mocked(isCameraScanSupported).mockReturnValue(false);
		await seedList({ listId: LIST });
		const onfallback = vi.fn();

		render(ScanButton, { props: { listId: LIST, onfallback } });
		await openScanner();

		expect(startCameraScan).not.toHaveBeenCalled();
		expect(screen.getByText('Dieses Gerät kann keine Barcodes scannen.')).toBeDefined();
		// Typing takes over once the message has had its beat and the overlay closed.
		await waitFor(() => expect(onfallback).toHaveBeenCalledTimes(1), { timeout: 3000 });
	});

	// §9.2: a miss drops into typing. Focused while the overlay is open, the
	// field lost focus to its trap, and the close handed it to the camera button.
	it('puts the focus where the fallback sends it once the overlay has closed', async () => {
		await seedList({ listId: LIST });
		mockScan(EAN);
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ status: 0 }));
		const field = document.createElement('input');
		document.body.append(field);
		try {
			render(ScanButton, { props: { listId: LIST, onfallback: () => field.focus() } });
			await openScanner();
			await waitFor(() => expect(document.activeElement).toBe(field), { timeout: 3000 });
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			expect(document.activeElement).toBe(field);
		} finally {
			field.remove();
		}
	});

	it('shows the permission-denied message when the camera is refused', async () => {
		await seedList({ listId: LIST });
		mockScanRejects(new CameraPermissionDeniedError());

		render(ScanButton, { props: { listId: LIST } });
		await openScanner();

		await waitFor(() =>
			expect(
				screen.getByText('Kein Kamerazugriff. Erlaube die Kamera in den Browser-Einstellungen.')
			).toBeDefined()
		);
	});

	it('shows the unsupported message when no camera hardware exists (NotFoundError)', async () => {
		await seedList({ listId: LIST });
		mockScanRejects(new DOMException('no camera found', 'NotFoundError'));

		render(ScanButton, { props: { listId: LIST } });
		await openScanner();

		expect(await screen.findByText('Dieses Gerät kann keine Barcodes scannen.')).toBeDefined();
	});

	// [D-293] Android: another app holds the camera (NotReadableError).
	it('says the camera cannot be opened when another app holds it', async () => {
		await seedList({ listId: LIST });
		mockScanRejects(new DOMException('Could not start video source', 'NotReadableError'));

		render(ScanButton, { props: { listId: LIST } });
		await openScanner();

		expect(await screen.findByText(/Die Kamera lässt sich gerade nicht öffnen/)).toBeDefined();
	});

	it('shows the decode-failed message and falls back to typing when the decoder is broken', async () => {
		await seedList({ listId: LIST });
		mockScanRejects(new CameraDecodeError());
		const onfallback = vi.fn();

		render(ScanButton, { props: { listId: LIST, onfallback } });
		await openScanner();

		await waitFor(() =>
			expect(
				screen.getByText('Barcodes lassen sich gerade nicht lesen. Tippe den Namen ein.')
			).toBeDefined()
		);
		await waitFor(() => expect(onfallback).toHaveBeenCalledTimes(1), { timeout: 3000 });
	});

	// Closing the overlay is a cancel: a lookup that answers afterwards must not
	// add the item the user walked away from.
	it('closing while the lookup runs creates nothing when it answers', async () => {
		await seedList({ listId: LIST, categories: [makeCategory({ list: LIST, slug: 'pantry' })] });
		mockScan(EAN);
		let answer!: (r: Response) => void;
		vi.mocked(fetch).mockReturnValue(new Promise((r) => (answer = r)));
		const onadded = vi.fn();
		const itemsBefore = await db.items.count();

		render(ScanButton, { props: { listId: LIST, onadded } });
		await openScanner();
		expect(await screen.findByText('Produkt wird gesucht …')).toBeDefined();
		await fireEvent.click(screen.getByRole('button', { name: 'Scanner schließen' }));
		answer(jsonResponse({ name: 'Nutella', category_slug: 'pantry' }));
		await new Promise((r) => setTimeout(r, 50));

		expect(onadded).not.toHaveBeenCalled();
		expect(await db.items.count()).toBe(itemsBefore);
		expect(screen.queryByTestId('scan-message')).toBeNull();
	});

	// The camera's answer is the closed session's too: a barcode a decode already
	// in flight finds, or a refusal the permission prompt gives, after the user
	// closed the overlay must neither reopen it nor add anything.
	it('closing while the camera runs: a late barcode adds nothing and reopens nothing', async () => {
		await seedList({ listId: LIST, categories: [makeCategory({ list: LIST, slug: 'pantry' })] });
		let detect!: (barcode: string) => void;
		vi.mocked(startCameraScan).mockReturnValue({
			result: new Promise((r) => (detect = r)),
			stop: vi.fn()
		});
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ name: 'Nutella', category_slug: 'pantry' }));
		const onadded = vi.fn();
		const itemsBefore = await db.items.count();

		render(ScanButton, { props: { listId: LIST, onadded } });
		await openScanner();
		expect(await screen.findByText('Barcode ins Bild halten')).toBeDefined();
		await fireEvent.click(screen.getByRole('button', { name: 'Scanner schließen' }));
		detect(EAN);
		await new Promise((r) => setTimeout(r, 50));

		expect(fetch).not.toHaveBeenCalled();
		expect(onadded).not.toHaveBeenCalled();
		expect(await db.items.count()).toBe(itemsBefore);
		expect(screen.queryByTestId('scan-message')).toBeNull();
		expect(screen.queryByText('Barcode ins Bild halten')).toBeNull();
	});

	it('closing while the camera prompt is up: a late refusal reopens nothing', async () => {
		await seedList({ listId: LIST });
		let refuse!: (e: Error) => void;
		vi.mocked(startCameraScan).mockImplementation(() => ({
			result: new Promise((_, reject) => (refuse = reject)),
			stop: vi.fn()
		}));

		render(ScanButton, { props: { listId: LIST } });
		await openScanner();
		expect(await screen.findByText('Barcode ins Bild halten')).toBeDefined();
		await fireEvent.click(screen.getByRole('button', { name: 'Scanner schließen' }));
		refuse(new CameraPermissionDeniedError());
		await new Promise((r) => setTimeout(r, 50));

		expect(screen.queryByTestId('scan-message')).toBeNull();
	});

	// The previous session's "close after a beat" timer belongs to it alone.
	it("a new scan is not closed by the previous scan's pending timer", async () => {
		await seedList({ listId: LIST });
		mockScan(EAN);
		vi.mocked(fetch).mockResolvedValue(jsonResponse({}, false));

		render(ScanButton, { props: { listId: LIST } });
		await openScanner();
		expect(await screen.findByTestId('scan-message')).toBeDefined();
		await fireEvent.click(screen.getByRole('button', { name: 'Scanner schließen' }));

		vi.mocked(startCameraScan).mockReturnValue({ result: new Promise(() => {}), stop: vi.fn() });
		await openScanner();
		// Real time: the timer waited out was scheduled while findBy* polled,
		// which a fake clock would stall. scan-session.svelte.test.ts proves the
		// same on a fake clock, one level down.
		await new Promise((r) => setTimeout(r, 1400));

		expect(screen.getByText('Barcode ins Bild halten')).toBeDefined();
	});
});
