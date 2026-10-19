// Is any tab of the app on screen? (§8.5 [D-164]) The leader may be hidden
// while another tab shows its writes, so each visible tab holds a shared Web
// Lock and the leader asks for it. A lock rather than a heartbeat: the browser
// drops a closed or crashed tab's lock itself.

const LOCK = 'sync-visible';

// The slice of the Web Locks API used here (leader.ts types its own slice).
export interface VisibilityLocks {
	request(name: string, options: { mode: 'shared' }, callback: () => Promise<void>): Promise<void>;
	query?(): Promise<{ held?: { name?: string }[] }>;
}

interface VisibilityDocument {
	readonly visibilityState: string;
	addEventListener(type: 'visibilitychange', listener: () => void): void;
	removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface VisibilityTracker {
	/** This tab is on screen. Synchronous, so the common case costs nothing. */
	visibleHere(): boolean;
	/** This tab or any other tab of the app is on screen. */
	anyVisible(): Promise<boolean>;
	stop(): void;
}

export interface VisibilityOptions {
	locks?: VisibilityLocks;
	doc?: VisibilityDocument;
}

export function trackVisibility(opts: VisibilityOptions = {}): VisibilityTracker {
	const locks =
		opts.locks ?? (globalThis.navigator as { locks?: VisibilityLocks } | undefined)?.locks;
	// Typed as possibly absent: Node (the server test project, SSR) has no document.
	const doc: VisibilityDocument | undefined = opts.doc ?? globalThis.document;

	// Only an explicit 'hidden' counts: happy-dom and older engines report other
	// states (or none), and treating those as hidden would stop the tick.
	const visibleHere = () => doc?.visibilityState !== 'hidden';

	let release: (() => void) | null = null;
	const hold = () => {
		if (!locks || release) return;
		void locks
			.request(LOCK, { mode: 'shared' }, () => new Promise<void>((r) => (release = r)))
			.catch(() => {});
	};
	const drop = () => {
		release?.();
		release = null;
	};
	const onChange = () => (visibleHere() ? hold() : drop());

	doc?.addEventListener('visibilitychange', onChange);
	if (visibleHere()) hold();

	return {
		visibleHere,
		async anyVisible() {
			if (visibleHere()) return true;
			// No way to ask the other tabs: this is the only one we can see.
			if (!locks?.query) return false;
			try {
				const { held = [] } = await locks.query();
				return held.some((l) => l.name === LOCK);
			} catch {
				// Unsure means check: a wasted probe is cheaper than a stale tab.
				return true;
			}
		},
		stop() {
			doc?.removeEventListener('visibilitychange', onChange);
			drop();
		}
	};
}
