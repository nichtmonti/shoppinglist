// §9.2 step 1's camera and decoder failures. happy-dom has no camera, so the
// camera and the decoder chunk are both faked; what is under test is who
// releases the tracks, and which error each failure becomes ([D-21], [D-95]).
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const decoder = {
	// The decoder chunk failing to load: the offline first-scan shape, or a
	// chunk fetch that failed before the service worker took control.
	ponyfillFails: false,
	wasmFails: false,
	detect: vi.fn<() => Promise<{ rawValue: string }[]>>()
};

// A fresh copy per test, mocks included: decode.ts keeps the loaded decoder
// module for the session, and each test decides whether that load fails.
let decode: typeof import('./decode');

function mockDecoderChunks(): void {
	vi.doMock('barcode-detector/ponyfill', () => {
		if (decoder.ponyfillFails) throw new Error('chunk load failed');
		return {
			BarcodeDetector: class {
				detect = decoder.detect;
			},
			setZXingModuleOverrides: () => {}
		};
	});
	vi.doMock('zxing-wasm/reader/zxing_reader.wasm?url', () => {
		if (decoder.wasmFails) throw new Error('asset load failed');
		return { default: '/zxing_reader.wasm' };
	});
}

function fakeCamera() {
	const track = { stop: vi.fn() };
	const stream = { getTracks: () => [track] } as unknown as MediaStream;
	return { track, stream };
}

function domError(name: string): Error {
	const err = new Error(name);
	err.name = name;
	return err;
}

const video = { srcObject: null, play: vi.fn() } as unknown as HTMLVideoElement;

let getUserMedia: Mock<() => Promise<MediaStream>>;

beforeEach(async () => {
	vi.resetModules();
	mockDecoderChunks();
	decode = await import('./decode');
	decoder.ponyfillFails = false;
	decoder.wasmFails = false;
	decoder.detect.mockReset();
	getUserMedia = vi.fn<() => Promise<MediaStream>>();
	vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
	vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
	vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('startCameraScan', () => {
	it('stops the camera when the decoder module fails to load', async () => {
		decoder.ponyfillFails = true;
		const { track, stream } = fakeCamera();
		getUserMedia.mockResolvedValue(stream);

		const scan = decode.startCameraScan(video);

		await expect(scan.result).rejects.toThrow();
		expect(track.stop).toHaveBeenCalled();
	});

	it('stops a camera that only arrives after the scan was stopped', async () => {
		decoder.ponyfillFails = true;
		const { track, stream } = fakeCamera();
		let grant!: (s: MediaStream) => void;
		getUserMedia.mockReturnValue(new Promise<MediaStream>((r) => (grant = r)));

		const scan = decode.startCameraScan(video);
		scan.stop();
		grant(stream);

		await scan.result.catch(() => {});
		expect(track.stop).toHaveBeenCalled();
	});

	it('gives up after five failed frames in a row and stops the camera', async () => {
		const { track, stream } = fakeCamera();
		getUserMedia.mockResolvedValue(stream);
		decoder.detect.mockRejectedValue(new Error('memory access out of bounds'));

		const scan = decode.startCameraScan(video);

		await expect(scan.result).rejects.toBeInstanceOf(decode.CameraDecodeError);
		expect(decoder.detect).toHaveBeenCalledTimes(5);
		expect(track.stop).toHaveBeenCalled();
	});

	it('keeps scanning when a frame that found nothing breaks a run of failures', async () => {
		const { stream } = fakeCamera();
		getUserMedia.mockResolvedValue(stream);
		const fail = () => Promise.reject(new Error('transient'));
		decoder.detect
			.mockImplementationOnce(fail)
			.mockImplementationOnce(fail)
			.mockImplementationOnce(fail)
			.mockImplementationOnce(fail)
			.mockResolvedValueOnce([])
			.mockImplementationOnce(fail)
			.mockImplementationOnce(fail)
			.mockResolvedValueOnce([{ rawValue: '4006381333931' }]);

		const scan = decode.startCameraScan(video);

		await expect(scan.result).resolves.toBe('4006381333931');
	});

	it.each(['NotAllowedError', 'SecurityError'])(
		'reports a camera refused with %s as a denied permission',
		async (name) => {
			getUserMedia.mockRejectedValue(domError(name));

			const scan = decode.startCameraScan(video);

			await expect(scan.result).rejects.toBeInstanceOf(decode.CameraPermissionDeniedError);
		}
	);

	it('passes any other camera failure through as it is', async () => {
		getUserMedia.mockRejectedValue(domError('NotReadableError'));

		const scan = decode.startCameraScan(video);

		await expect(scan.result).rejects.toMatchObject({ name: 'NotReadableError' });
	});

	it.each([
		['decoder module', 'ponyfillFails'],
		['.wasm', 'wasmFails']
	] as const)('retries a %s that failed to load at the next scan', async (_, flag) => {
		getUserMedia.mockImplementation(() => Promise.resolve(fakeCamera().stream));
		decoder.detect.mockResolvedValue([{ rawValue: '4006381333931' }]);

		decoder[flag] = true;
		await expect(decode.startCameraScan(video).result).rejects.toThrow();

		// Back online: the same session scans again without a reload.
		decoder[flag] = false;
		await expect(decode.startCameraScan(video).result).resolves.toBe('4006381333931');
	});
});
