// The client half of the §8.3 field contract.
//
// These assert the SHAPE the client relies on, not the numbers themselves — the
// numbers are the shared artefact's business, and pinning them here would just
// be a second copy of the thing this module exists to stop duplicating. What
// matters is that the client reads the same file the server enforces from, which
// the integration suite proves against the real binary
// ("denied (field too long): the row reverts and the client is told why").
import { describe, it, expect } from 'vitest';
import contract from '../../../backend/internal/fieldcontract/field-contract.json';
import { SERVER_STAMPED_FIELDS, MAX_OPS_PER_PUSH, maxBytesFor, byteLength } from './field-contract';
import type { ContractCollection } from './field-contract';

describe('field-contract', () => {
	it('reads the shared artefact, not a local copy', () => {
		expect(maxBytesFor('items', 'note')).toBe(contract.collections.items.writable.note.max_bytes);
		expect(SERVER_STAMPED_FIELDS).toEqual(contract.server_stamped);
	});

	it('MAX_OPS_PER_PUSH is a usable drain-chunk bound from the shared artefact', () => {
		// Shape, not the number — the value is the contract's business. The drain
		// chunks against it and the server 400s anything larger, so a non-positive
		// or fractional value here would break the outbox at load time.
		expect(Number.isInteger(MAX_OPS_PER_PUSH)).toBe(true);
		expect(MAX_OPS_PER_PUSH).toBeGreaterThan(0);
		expect(MAX_OPS_PER_PUSH).toBe(contract.max_ops_per_push);
	});

	it('every capped field the outbox can send is a string field', () => {
		// checked / sort_order are bool+number and must carry no byte cap, or
		// the cap checks (Go's fieldProblems, maxBytesFor here) would skip them
		// for the wrong reason.
		expect(maxBytesFor('items', 'checked')).toBeUndefined();
		expect(maxBytesFor('list_categories', 'sort_order')).toBeUndefined();
	});

	it('unknown collections and fields have no cap', () => {
		expect(maxBytesFor('items', 'modified_by')).toBeUndefined();
		// Not reachable through the typed API — asserted because the lookup walks two
		// levels of a plain JSON object and an unknown collection must not throw.
		// ([D-08] retired the previous stand-in here, 'accounts': it is a real
		// contract collection now, so the cast stopped being a cast.)
		expect(maxBytesFor('invites' as ContractCollection, 'token_hash')).toBeUndefined();
		// A known collection with an unknown field is the other miss.
		expect(maxBytesFor('accounts', 'handle')).toBeUndefined();
	});

	it('server-stamped columns are never writable, so never capped', () => {
		for (const field of SERVER_STAMPED_FIELDS) {
			expect(maxBytesFor('items', field)).toBeUndefined();
		}
	});

	it('the byte cap as an input maxlength is an approximation the server backstops', () => {
		const cap = maxBytesFor('items', 'name')!;
		// Exactly the gap the `denied` path exists to catch: this passes an input
		// capped at `cap` characters and still exceeds `cap` BYTES.
		const emoji = '🥕'.repeat(cap / 2);
		expect(emoji.length).toBeLessThanOrEqual(cap);
		expect(byteLength(emoji)).toBeGreaterThan(cap);
	});

	it('the route-written collections are reachable from the client', () => {
		// [D-08]. These are NOT push collections — server routes write them, and
		// those routes save with SaveNoValidate, so their caps live in the same
		// artefact for the same reason, and the inputs that write them must see
		// those caps too. Shape, not numbers, as everywhere else in this file.
		for (const [collection, field] of [
			['lists', 'name'],
			['accounts', 'nickname'],
			['credentials', 'friendly_name']
		] as const) {
			const cap = maxBytesFor(collection, field);
			expect(cap, `${collection}.${field} has no cap`).toBeGreaterThan(0);
			expect(maxBytesFor(collection, field)).toBe(cap);
		}
	});

	it('slug is absent from the writable allowlist', () => {
		// [D-08]. `slug` is server-owned: §7.5 copies it from category_templates
		// and the push route refuses it by name. Giving it a `writable` entry to
		// get it a byte cap would ALSO make it settable through §8.3 push, which
		// is what `fieldcontract.Writable` reads (via `fieldProblems`) — so its absence here is the decision,
		// not an oversight, and backup.ts must not pretend to cap-check it.
		expect(maxBytesFor('list_categories', 'slug')).toBeUndefined();
		expect(Object.keys(contract.collections.list_categories.writable)).not.toContain('slug');
	});

	it('byteLength counts UTF-8 bytes, not code units', () => {
		expect(byteLength('abc')).toBe(3);
		expect(byteLength('äöü')).toBe(6);
		expect(byteLength('🥕')).toBe(4);
	});
});
