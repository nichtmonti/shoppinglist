// §9.2 step 1: camera scan, getUserMedia + the `barcode-detector` ponyfill,
// which decodes with zxing-wasm on every browser, never a native detector
// ([D-21]). Component tests mock this module wholesale; decode.test.ts covers
// the camera's lifetime and each failure's outcome.
//
// WASM loading:
// 1. Left unconfigured, the ponyfill fetches its .wasm from the jsDelivr CDN.
//    ensureLocalWasm points it at a same-origin, SW-cacheable copy instead.
// 2. `prepareZXingModule` MUST come from `barcode-detector/ponyfill`: it
//    inlines its own copy of zxing-wasm's reader, with its own module state,
//    so preparing via `zxing-wasm/reader` has no effect.
// 3. The .wasm bytes come from the `zxing-wasm` package via `?url`, which MUST
//    be the exact version the ponyfill inlines its glue from: any other build
//    makes every detect() throw "memory access out of bounds" ([D-21],
//    wasm-version.test.ts).
// 4. The .wasm is not precached ([D-95]): a first scan while offline fails
//    to instantiate it, which ends that scan with CameraDecodeError. The
//    ponyfill keeps a failed module as it keeps a good one, so it is purged:
//    otherwise every later scan, online too, would fail until a reload.
//
// The ponyfill and the 1MB .wasm load DYNAMICALLY at the first scan, so they do
// not ride on every route with a scan button; the `?url` import is only the
// file's address.
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

// One object for the session: the ponyfill reuses its module while the
// overrides it is given are the same, and instantiates again when they differ.
const overrides = {
	locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path)
};

/** A detector on the bundled .wasm, instantiated once; a failed
 *  instantiation is dropped, so the next scan tries again. */
async function createDetector(): Promise<
	InstanceType<typeof import('barcode-detector/ponyfill').BarcodeDetector>
> {
	const { BarcodeDetector, prepareZXingModule, purgeZXingModule } =
		await import('barcode-detector/ponyfill');
	try {
		await prepareZXingModule({ overrides, fireImmediately: true });
	} catch {
		purgeZXingModule();
		throw new CameraDecodeError();
	}
	return new BarcodeDetector({ formats: [...RETAIL_FORMATS] });
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
	if (!isCameraScanSupported()) {
		return { result: Promise.reject(new CameraUnsupportedError()), stop: () => {} };
	}

	let stopped = false;
	let stream: MediaStream | null = null;
	let rafId: number | null = null;
	// One failed frame is transient, but a decoder that fails frame after
	// frame must not spin forever behind a live camera with no outcome.
	let consecutiveDecodeErrors = 0;
	const MAX_CONSECUTIVE_DECODE_ERRORS = 5;

	const result = new Promise<string>((resolve, reject) => {
		// In parallel, so the permission prompt does not wait for the module.
		const media = navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
		const module = createDetector();
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
