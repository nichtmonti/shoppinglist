// "Now", for views that change with time alone (§6.10): the done pile empties
// when the trip ends ([D-18]), and "heute" becomes "gestern" at midnight. A
// $derived over Date.now() would only re-run when rows change. `value` moves
// when the view's `nextChange` says, and when the tab becomes visible again
// (a backgrounded tab's timers are throttled or frozen). Construct it during
// component init: the scheduling is an effect.
// The longest setTimeout waits; a longer delay fires at once. A change further
// out (a checked_at stamped ahead of a wrong device clock) re-arms on waking.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export class Now {
	value = $state(Date.now());

	/** @param nextChange when the caller's answer next changes, given now —
	 *  null for "not by time alone". */
	constructor(nextChange: (now: number) => number | null) {
		$effect(() => {
			const at = nextChange(this.value);
			if (at === null) return;
			// +1s so drift cannot land the tick just before the boundary.
			const timer = setTimeout(
				() => (this.value = Date.now()),
				Math.min(MAX_TIMEOUT_MS, Math.max(1000, at - Date.now() + 1000))
			);
			return () => clearTimeout(timer);
		});
		$effect(() => {
			if (typeof document === 'undefined') return;
			const onVisible = () => {
				if (document.visibilityState === 'visible') this.value = Date.now();
			};
			document.addEventListener('visibilitychange', onVisible);
			return () => document.removeEventListener('visibilitychange', onVisible);
		});
	}
}

/** The earlier of two next-change times, either of which may be null. */
export function earliest(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}
