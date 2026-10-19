// §9.2 one scanner overlay's life: camera → barcode → the item it brings back
// or creates, with what the overlay says on the way. ScanButton renders it;
// the camera, the lookup and the writes are passed in, so this holds only the
// order of things and the rule that a closed overlay acts on nothing:
// every close bumps a generation that each late answer checks, and one timer
// closes the overlay after a beat, cleared by every close so a new scan never
// inherits it.
import { tick } from 'svelte';
import type { MessageKey } from '#lib/i18n/index.js';
import type { Item } from '#lib/db.js';
import {
	CameraDecodeError,
	CameraPermissionDeniedError,
	CameraUnsupportedError,
	type CameraScan
} from './decode';
import type { ResolvedProduct } from './resolve';

export type ScanStatus =
	| 'idle'
	| 'unsupported'
	| 'scanning'
	| 'looking_up'
	| 'found'
	| 'permission_denied'
	| 'camera_busy'
	| 'decode_failed'
	| 'not_found'
	| 'offline_miss';

const MESSAGES: Partial<Record<ScanStatus, MessageKey>> = {
	unsupported: 'scan_unsupported',
	permission_denied: 'scan_permission_denied',
	camera_busy: 'scan_camera_busy',
	decode_failed: 'scan_decode_failed',
	not_found: 'scan_not_found',
	offline_miss: 'scan_offline_miss',
	looking_up: 'scan_looking_up'
};

export interface ScanDeps {
	/** Whether this device can scan at all. */
	supported: () => boolean;
	/** Starts the camera on `video`, decoding until a barcode shows. */
	start: (video: HTMLVideoElement) => CameraScan;
	/** The row on the list that already has `barcode` (§9.1 scan-dedup). */
	onList: (barcode: string) => Promise<Item | undefined>;
	/** Brings that row back instead of adding a second one. */
	reuse: (item: Item) => Promise<void>;
	/** The product `barcode` names, or null for a miss (§9.2 step 2). */
	resolve: (barcode: string) => Promise<ResolvedProduct | null>;
	/** Adds `product` to the list; resolves the new row's id (§9.2 step 3). */
	create: (barcode: string, product: ResolvedProduct) => Promise<string>;
	/** A row was added from the scan. */
	added: (itemId: string) => void;
	isOnline: () => boolean;
}

/** How long a miss is said before the overlay drops into typing. */
const MISS_MS = 1200;
/** A beat so the image and its required attribution (§9.2) are seen. */
const FOUND_MS = 900;

export class ScanSession {
	status = $state<ScanStatus>('idle');
	foundProduct = $state<ResolvedProduct | null>(null);
	/** What the overlay says, for a status that says something. */
	readonly message = $derived(MESSAGES[this.status]);

	#deps: ScanDeps;
	#camera: CameraScan | null = null;
	// Bumped by every close and on unmount, so a late await sees its session is
	// gone.
	#gen = 0;
	// The one pending "close after a beat" timer; a new session must not inherit it.
	#resetTimer: ReturnType<typeof setTimeout> | undefined;
	// A miss drops into typing (§9.2) once the overlay has closed: while it is
	// open its focus trap pulls focus back, and on close it returns focus to
	// the camera button unless told otherwise.
	#fallbackDue = false;

	constructor(deps: ScanDeps) {
		this.#deps = deps;
	}

	open(): void {
		if (!this.#deps.supported()) {
			// A beat on the message, then the same drop into typing as a miss (§9.2).
			this.status = 'unsupported';
			this.#fallbackDue = true;
			this.#closeAfter(MISS_MS);
			return;
		}
		this.#fallbackDue = false;
		this.status = 'scanning';
	}

	/** The overlay's <video> is up: start the camera on it, once per session. */
	startCamera(video: HTMLVideoElement): void {
		if (this.status !== 'scanning' || this.#camera) return;
		const started = this.#deps.start(video);
		this.#camera = started;
		// A closed overlay disowns the camera's late answer: a decode already in
		// flight, or the permission prompt answered after the close.
		const gen = this.#gen;
		started.result
			.then((barcode) => {
				if (gen === this.#gen) return this.#detected(barcode);
			})
			.catch((err: unknown) => {
				if (gen !== this.#gen) return;
				this.#camera = null;
				if (err instanceof CameraPermissionDeniedError) {
					this.status = 'permission_denied';
				} else if (err instanceof CameraDecodeError) {
					// The decoder is broken (offline first scan): fall back to typing.
					this.status = 'decode_failed';
					this.#fallbackDue = true;
					this.#closeAfter(MISS_MS);
				} else if (
					err instanceof CameraUnsupportedError ||
					(err instanceof DOMException && err.name === 'NotFoundError')
				) {
					// No camera hardware (NotFoundError) is the same dead end as no
					// getUserMedia: say so rather than snap back to idle.
					this.status = 'unsupported';
				} else {
					// Another app holds the camera, or it would not start: said,
					// not a scanner that flashes and vanishes ([D-293]).
					this.status = 'camera_busy';
				}
			});
	}

	/** Closes the overlay, disowning whatever is in flight. */
	close = (): void => {
		this.#stop();
		this.status = 'idle';
		this.foundProduct = null;
	};

	/** Unmounted mid-scan: stops the camera and disowns whatever is in flight. */
	destroy(): void {
		this.#stop();
	}

	/** Whether the overlay, closing, hands the focus to typing; asked once. */
	takeFallback(): boolean {
		const due = this.#fallbackDue;
		this.#fallbackDue = false;
		return due;
	}

	#stop(): void {
		this.#gen++;
		clearTimeout(this.#resetTimer);
		this.#camera?.stop();
		this.#camera = null;
	}

	#closeAfter(ms: number): void {
		clearTimeout(this.#resetTimer);
		this.#resetTimer = setTimeout(this.close, ms);
	}

	async #detected(barcode: string): Promise<void> {
		this.#camera?.stop();
		this.#camera = null;
		this.status = 'looking_up';

		// Closing the overlay while the reads run cancels the scan.
		const gen = this.#gen;
		// A barcode already on this list needs no lookup: the same §9.1 dedup
		// handling as the typeahead.
		const existing = await this.#deps.onList(barcode);
		if (gen !== this.#gen) return;
		if (existing) {
			this.close();
			// Reveal the row once the overlay has unmounted.
			await tick();
			await this.#deps.reuse(existing);
			return;
		}

		const online = this.#deps.isOnline();
		const product = await this.#deps.resolve(barcode);
		if (gen !== this.#gen) return;
		if (!product) {
			this.status = online ? 'not_found' : 'offline_miss';
			// The message gets a beat; the fallback follows the overlay's close.
			this.#fallbackDue = true;
			this.#closeAfter(MISS_MS);
			return;
		}

		this.foundProduct = product;
		this.status = 'found';
		const itemId = await this.#deps.create(barcode, product);
		if (gen !== this.#gen) return;
		this.#deps.added(itemId);
		this.#closeAfter(FOUND_MS);
	}
}
