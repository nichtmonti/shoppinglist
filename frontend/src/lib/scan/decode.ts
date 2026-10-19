// §9.2 step 1: camera scan, getUserMedia + the `barcode-detector` ponyfill,
// which decodes with zxing-wasm on every browser, never a native detector
// ([D-21]). Component tests mock this module wholesale; decode.test.ts covers
// the camera's lifetime and each failure's outcome.
//
// WASM loading:
// 1. Left unconfigured, the ponyfill fetches its .wasm from the jsDelivr CDN.
//    ensureLocalWasm points it at a same-origin, SW-cacheable copy instead.
// 2. `setZXingModuleOverrides` MUST come from `barcode-detector/ponyfill`: it
//    inlines its own copy of zxing-wasm's reader, with its own override state,
//    so overriding via `zxing-wasm/reader` has no effect.
// 3. The .wasm bytes come from the `zxing-wasm` package via `?url`, which MUST
//    be the exact version the ponyfill inlines its glue from: any other build
//    makes every detect() throw "memory access out of bounds" ([D-21],
//    wasm-version.test.ts).
// 4. The .wasm is not precached ([D-95]): a first scan while offline fails
//    silently on every detect(), which startCameraScan bounds with
//    CameraDecodeError.
//
// The ponyfill and the 1MB .wasm load DYNAMICALLY at the first scan, so they do
// not ride on every route with a scan button.

let ponyfillModule: Promise<typeof import('barcode-detector/ponyfill')> | null = null;
function loadPonyfill(): Promise<typeof import('barcode-detector/ponyfill')> {
	// A rejected load must not stick: a transient chunk-fetch failure would
	// otherwise break every later scan until reload.
	return (ponyfillModule ??= import('barcode-detector/ponyfill').catch((err: unknown) => {
		ponyfillModule = null;
		throw err;
	}));
}

let wasmUrlPromise: Promise<string> | null = null;
function loadWasmUrl(): Promise<string> {
	return (wasmUrlPromise ??= import('zxing-wasm/reader/zxing_reader.wasm?url')
		.then((m) => m.default)
		.catch((err: unknown) => {
			wasmUrlPromise = null;
			throw err;
		}));
}

let overrideInstalled = false;

/** Idempotent: point the ponyfill's WASM loader at the bundled asset. */
function ensureLocalWasm(
	setZXingModuleOverrides: (typeof import('barcode-detector/ponyfill'))['setZXingModuleOverrides'],
	wasmUrl: string
): void {
	if (overrideInstalled) return;
	setZXingModuleOverrides({
		locateFile: (path: string, prefix: string): string =>
			path.endsWith('.wasm') ? wasmUrl : prefix + path
	});
	overrideInstalled = true;
}

export class CameraUnsupportedError extends Error {
	constructor() {
		super('getUserMedia is not available on this device');
		this.name = 'CameraUnsupportedError';
	}
}

export class CameraPermissionDeniedError extends Error {
	constructor() {
		super('camera permission was denied');
		this.name = 'CameraPermissionDeniedError';
	}
}

export class CameraDecodeError extends Error {
	constructor() {
		super('barcode decoding is unavailable (decoder failed repeatedly)');
		this.name = 'CameraDecodeError';
	}
}

export function isCameraScanSupported(): boolean {
	return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

// E2E-ONLY hook: e2e/tests/scan.spec.ts injects a decoded value and skips
// straight to §9.2 step 2. Only page.addInitScript sets it, never the app.
declare global {
	interface Window {
		__e2eFakeBarcode?: string;
	}
}

export interface CameraScan {
	/** Resolves with the first decoded barcode value. Rejects with
	 * CameraPermissionDeniedError, CameraUnsupportedError, CameraDecodeError
	 * (the decoder failed repeatedly), or another Error. */
	result: Promise<string>;
	/** Stops the camera stream and the detect loop. Idempotent, and safe to
	 * call after `result` has already settled. */
	stop: () => void;
}

// The retail formats §9.2 targets.
const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const;

function stopTracks(stream: MediaStream): void {
	stream.getTracks().forEach((track) => track.stop());
}

/** Starts the camera into `video` and polls frames for a barcode (§9.2 step 1). */
export function startCameraScan(video: HTMLVideoElement): CameraScan {
	const fake = typeof window !== 'undefined' ? window.__e2eFakeBarcode : undefined;
	if (fake) {
		return { result: Promise.resolve(fake), stop: () => {} };
	}
	if (!isCameraScanSupported()) {
		return { result: Promise.reject(new CameraUnsupportedError()), stop: () => {} };
	}

	let stopped = false;
	let stream: MediaStream | null = null;
	let rafId: number | null = null;
	// One failed frame is transient, but a BROKEN decoder (the .wasm never
	// loaded) must not spin forever behind a live camera with no outcome.
	let consecutiveDecodeErrors = 0;
	const MAX_CONSECUTIVE_DECODE_ERRORS = 5;

	const result = new Promise<string>((resolve, reject) => {
		// In parallel, so the permission prompt does not wait for the module.
		const media = navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
		const module = Promise.all([loadPonyfill(), loadWasmUrl()]).then(
			([{ BarcodeDetector, setZXingModuleOverrides }, wasmUrl]) => {
				ensureLocalWasm(setZXingModuleOverrides, wasmUrl);
				return new BarcodeDetector({ formats: [...RETAIL_FORMATS] });
			}
		);
		// Held as soon as it resolves, so stop() and the failure path can release
		// it whatever happens to the decoder.
		media.then(
			(mediaStream) => {
				if (stopped) stopTracks(mediaStream);
				else stream = mediaStream;
			},
			() => {}
		);
		Promise.all([media, module])
			.then(async ([mediaStream, detector]) => {
				if (stopped) return;
				video.srcObject = mediaStream;
				await video.play();

				const tick = async (): Promise<void> => {
					if (stopped) return;
					try {
						const detections = await detector.detect(video);
						if (stopped) return;
						if (detections.length > 0) {
							resolve(detections[0].rawValue);
							return;
						}
						consecutiveDecodeErrors = 0;
					} catch {
						if (++consecutiveDecodeErrors >= MAX_CONSECUTIVE_DECODE_ERRORS) {
							stop();
							reject(new CameraDecodeError());
							return;
						}
					}
					if (!stopped) rafId = requestAnimationFrame(() => void tick());
				};
				void tick();
			})
			.catch((err: unknown) => {
				// A failed scan leaves no camera running, whichever half failed.
				stop();
				const name = err instanceof Error ? err.name : '';
				if (name === 'NotAllowedError' || name === 'SecurityError') {
					reject(new CameraPermissionDeniedError());
				} else {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
	});

	function stop(): void {
		stopped = true;
		if (rafId !== null) cancelAnimationFrame(rafId);
		if (stream) stopTracks(stream);
		stream = null;
	}

	return { result, stop };
}
