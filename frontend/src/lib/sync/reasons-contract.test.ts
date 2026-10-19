// Pins the client's hand-maintained copies of the contract sets to the shared
// artefact (backend/internal/fieldcontract/field-contract.json):
//
//   - DENIED_REASONS (./types) — the union and the Go const block drifted once
//     already ([D-08] added bad_record_id server-side and it never reached the
//     client), so the array is now asserted against the contract's
//     denied_reasons. PUSH_STATUSES the same way, against push_statuses.
//   - STAMP_COMPANIONS (./materialize) — the stamps an op keeps beside their
//     field are exactly the contract's server_stamped columns.
//   - the row shapes emitted by normalizeItem / normalizeCategory (./record) —
//     the items columns were enumerated in seven places, of which the writable
//     contract covered only the smallest subset.
//
// A separate file rather than an extension of field-contract.test.ts so the
// assertions import ./types and ./record without any cycle concern.
import { describe, it, expect } from 'vitest';
import {
	CONTRACT_DENIED_REASONS,
	CONTRACT_PUSH_STATUSES,
	CONTRACT_ROW_SHAPE,
	SERVER_STAMPED_FIELDS
} from '#lib/field-contract.js';
import { DENIED_REASONS, PUSH_STATUSES } from './types';
import { normalizeItem, normalizeCategory } from './record';
import { STAMP_COMPANIONS } from './materialize';

describe('denied reasons pinned to the contract', () => {
	it('the client union cannot omit a code the contract carries (or vice versa)', () => {
		expect([...CONTRACT_DENIED_REASONS].sort()).toEqual([...DENIED_REASONS].sort());
	});
});

describe('push statuses pinned to the contract', () => {
	it('the client union carries exactly the contract statuses', () => {
		expect([...CONTRACT_PUSH_STATUSES].sort()).toEqual([...PUSH_STATUSES].sort());
	});
});

describe('stamp companions pinned to the contract', () => {
	it('the stamps an op keeps are exactly the server-stamped columns', () => {
		expect(Object.values(STAMP_COMPANIONS).flat().sort()).toEqual(
			[...SERVER_STAMPED_FIELDS].sort()
		);
	});
});

describe('row shape pinned to the contract', () => {
	it('normalizeItem emits exactly the contract items columns', () => {
		expect(Object.keys(normalizeItem({})).sort()).toEqual([...CONTRACT_ROW_SHAPE.items].sort());
	});

	it('normalizeCategory emits exactly the contract list_categories columns', () => {
		expect(Object.keys(normalizeCategory({})).sort()).toEqual(
			[...CONTRACT_ROW_SHAPE.list_categories].sort()
		);
	});
});
