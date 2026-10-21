// §9.2 the scanner overlay's session without the overlay: the camera,
// the lookup and the writes are fakes, so each late answer can be held back
// and let go after a close. ScanButton.svelte.test.ts drives the same through
// the real component and Dexie.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraPermissionDeniedError } from './decode';
import { LOOKUP_FAILED, type ResolvedProduct } from './resolve';
import { ScanSession, type ScanDeps } from './scan-session.svelte';

const EAN = '3017620422003';
const video = {} as HTMLVideoElement;
const product: ResolvedProduct = {
	name: 'Nutella',
	name_de: null,
	name_en: null,
	image_url: null,
	category_slug: 'pantry',
	fromCache: false
};

/** A promise and the hands that settle it. */
function held<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function session(overrides: Partial<ScanDeps> = {}) {
	const deps: ScanDeps = {
		supported: () => true,
		start: () => ({ result: Promise.resolve(EAN), stop: vi.fn() }),
		onList: async () => undefined,
		reuse: vi.fn(async () => {}),
		resolve: vi.fn(async () => product),
		create: vi.fn(async () => 'item-1'),
		added: vi.fn(),
		isOnline: () => true,
		...overrides
	};
	return { scan: new ScanSession(deps), deps };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	vi.useRealTimers();
});

describe('ScanSession', () => {
	it('adds what the barcode names, says so, and closes after a beat', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { scan, deps } = session();
		scan.open();
		scan.startCamera(video);
		await vi.advanceTimersByTimeAsync(0);

		expect(deps.create).toHaveBeenCalledWith(EAN, product);
		expect(deps.added).toHaveBeenCalledWith('item-1');
		expect(scan.status).toBe('found');
		expect(scan.foundProduct).toEqual(product);
		await vi.advanceTimersByTimeAsync(900);
		expect(scan.status).toBe('idle');
	});

	it('brings back the row the list already has, without a lookup', async () => {
		const row = { id: 'row-1' } as never;
		const { scan, deps } = session({ onList: async () => row });
		scan.open();
		scan.startCamera(video);
		await settle();

		expect(deps.resolve).not.toHaveBeenCalled();
		expect(deps.reuse).toHaveBeenCalledWith(row);
		expect(scan.status).toBe('idle');
	});

	it('starts the camera once per session', () => {
		const start = vi.fn(() => ({ result: new Promise<string>(() => {}), stop: vi.fn() }));
		const { scan } = session({ start });
		scan.startCamera(video);
		expect(start).not.toHaveBeenCalled();
		scan.open();
		scan.startCamera(video);
		scan.startCamera(video);
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('acts on nothing a closed session answers late', async () => {
		const lookup = held<ResolvedProduct | null>();
		const { scan, deps } = session({ resolve: () => lookup.promise });
		scan.open();
		scan.startCamera(video);
		await settle();
		expect(scan.status).toBe('looking_up');

		scan.close();
		lookup.resolve(product);
		await settle();
		expect(deps.create).not.toHaveBeenCalled();
		expect(scan.status).toBe('idle');

		const camera = held<string>();
		const stop = vi.fn();
		const late = session({ start: () => ({ result: camera.promise, stop }) });
		late.scan.open();
		late.scan.startCamera(video);
		late.scan.close();
		expect(stop).toHaveBeenCalled();
		camera.reject(new CameraPermissionDeniedError());
		await settle();
		expect(late.scan.status).toBe('idle');
	});

	it("does not let a closed session's timer close the next one", async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let first = true;
		const { scan } = session({
			start: () => ({
				result: first ? Promise.resolve(EAN) : new Promise<string>(() => {}),
				stop: vi.fn()
			}),
			resolve: async () => null
		});
		scan.open();
		scan.startCamera(video);
		await vi.advanceTimersByTimeAsync(0);
		expect(scan.status).toBe('not_found');

		scan.close();
		first = false;
		scan.open();
		scan.startCamera(video);
		await vi.advanceTimersByTimeAsync(1400);
		expect(scan.status).toBe('scanning');
	});

	it('says a lookup that got no answer as a failure, not as a miss', async () => {
		const { scan } = session({ resolve: async () => LOOKUP_FAILED });
		scan.open();
		scan.startCamera(video);
		await settle();

		expect(scan.status).toBe('lookup_failed');
		expect(scan.message).toBe('scan_lookup_failed');
		expect(scan.takeFallback()).toBe(true);
	});

	it('says an offline miss as one, and hands the focus to typing once', async () => {
		const { scan } = session({ resolve: async () => null, isOnline: () => false });
		scan.open();
		scan.startCamera(video);
		await settle();

		expect(scan.status).toBe('offline_miss');
		expect(scan.message).toBe('scan_offline_miss');
		expect(scan.takeFallback()).toBe(true);
		expect(scan.takeFallback()).toBe(false);
	});

	it('names why the camera did not start', async () => {
		const failing = async (error: Error) => {
			const { scan } = session({ start: () => ({ result: Promise.reject(error), stop: vi.fn() }) });
			scan.open();
			scan.startCamera(video);
			await settle();
			return scan.status;
		};
		expect(await failing(new CameraPermissionDeniedError())).toBe('permission_denied');
		expect(await failing(new DOMException('', 'NotFoundError'))).toBe('unsupported');
		expect(await failing(new DOMException('', 'NotReadableError'))).toBe('camera_busy');
	});

	it('says a device without a camera cannot scan, and drops into typing', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { scan } = session({ supported: () => false });
		scan.open();
		expect(scan.status).toBe('unsupported');
		vi.advanceTimersByTime(1200);
		expect(scan.status).toBe('idle');
		expect(scan.takeFallback()).toBe(true);
	});
});
