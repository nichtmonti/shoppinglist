import { describe, expect, it } from 'vitest';
import { trackVisibility, type VisibilityLocks } from './visibility';

// A document whose visibility the test sets, and a Web Locks stand-in that
// keeps held shared locks in one registry — the part of the real API that
// makes "is any tab visible?" answerable across tabs ([D-164]).
function fakeDoc(state: 'visible' | 'hidden') {
	const listeners = new Set<() => void>();
	return {
		visibilityState: state as string,
		addEventListener: (_: 'visibilitychange', l: () => void) => void listeners.add(l),
		removeEventListener: (_: 'visibilitychange', l: () => void) => void listeners.delete(l),
		set(next: 'visible' | 'hidden') {
			this.visibilityState = next;
			listeners.forEach((l) => l());
		}
	};
}

function fakeLocks() {
	const held: { name: string }[] = [];
	const locks: VisibilityLocks = {
		async request(name, _options, callback) {
			const entry = { name };
			held.push(entry);
			await callback();
			held.splice(held.indexOf(entry), 1);
		},
		async query() {
			return { held: [...held] };
		}
	};
	return { locks, held };
}

// Lets the lock callbacks' promise chains settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('trackVisibility', () => {
	it('a visible tab answers from its own document without asking the locks', async () => {
		const doc = fakeDoc('visible');
		const locks: VisibilityLocks = {
			request: () => new Promise(() => {}),
			query: () => Promise.reject(new Error('must not be asked'))
		};
		const t = trackVisibility({ doc, locks });
		expect(t.visibleHere()).toBe(true);
		expect(await t.anyVisible()).toBe(true);
		t.stop();
	});

	it('holds the shared lock only while visible', async () => {
		const doc = fakeDoc('visible');
		const { locks, held } = fakeLocks();
		const t = trackVisibility({ doc, locks });
		await settle();
		expect(held).toHaveLength(1);
		doc.set('hidden');
		await settle();
		expect(held).toHaveLength(0);
		doc.set('visible');
		await settle();
		expect(held).toHaveLength(1);
		t.stop();
		await settle();
		expect(held).toHaveLength(0);
	});

	it('a hidden leader sees another visible tab through the lock', async () => {
		const { locks } = fakeLocks();
		const other = trackVisibility({ doc: fakeDoc('visible'), locks });
		const leader = trackVisibility({ doc: fakeDoc('hidden'), locks });
		await settle();
		expect(leader.visibleHere()).toBe(false);
		expect(await leader.anyVisible()).toBe(true);
		other.stop();
		await settle();
		expect(await leader.anyVisible()).toBe(false);
		leader.stop();
	});

	it('without Web Locks a hidden tab counts as nobody looking', async () => {
		const t = trackVisibility({
			doc: fakeDoc('hidden'),
			locks: { request: () => Promise.resolve() }
		});
		expect(await t.anyVisible()).toBe(false);
		t.stop();
	});

	it('a failing query errs toward checking', async () => {
		const t = trackVisibility({
			doc: fakeDoc('hidden'),
			locks: {
				request: () => Promise.resolve(),
				query: () => Promise.reject(new Error('boom'))
			}
		});
		expect(await t.anyVisible()).toBe(true);
		t.stop();
	});

	it('only an explicit "hidden" counts as hidden', () => {
		const doc = fakeDoc('visible');
		doc.visibilityState = 'prerender';
		const t = trackVisibility({ doc });
		expect(t.visibleHere()).toBe(true);
		t.stop();
	});
});
