package sync

import (
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/tombstone"
)

// tombstoneVerdict applies §8.3's special cases around the `deleted` signal and
// an existing tombstone. A non-nil result settles the op; nil means the
// per-field merge runs.
func tombstoneVerdict(txApp core.App, op pushOp, current *core.Record, callerID string) (*pushResult, error) {
	// fieldProblems has refused a `deleted` that is not a bool.
	deleted, signalled := op.Changed["deleted"].(bool)

	// Others protection ([D-30])
	if op.Collection == collectionCategories && deleted && current.GetString("slug") == "other" {
		r := deniedField(op, reasonProtectedRow, "deleted")
		return &r, nil
	}
	if tombstone.Living(current) {
		return nil, nil
	}

	switch {
	case deleted:
		// Convergent delete ([D-175]). A check-off coalesced into the late op
		// is still a purchase: only last_bought_at is stamped (§6.10).
		if op.Collection == collectionItems && boolFromChanged(op.Changed, "checked") {
			current.Set("last_bought_at", now())
			current.Set("modified_by", callerID)
			if err := txApp.SaveNoValidate(current); err != nil {
				return nil, err
			}
			return &pushResult{OpID: op.OpID, Status: statusApplied, Record: recordMap(op.Collection, current)}, nil
		}
		return &pushResult{OpID: op.OpID, Status: statusNoop, Record: recordMap(op.Collection, current)}, nil
	case signalled:
		// [D-176] A restore that would lift a tombstone while a living row of
		// the same name is on the list merges into that row instead.
		if op.Collection == collectionItems {
			merged, ok, err := mergeRestore(txApp, op, current, callerID)
			if err != nil {
				return nil, err
			}
			if ok {
				return &merged, nil
			}
		}
		return nil, nil
	default:
		// An edit to a row someone removed meanwhile.
		return &pushResult{
			OpID:      op.OpID,
			Status:    statusDeletedConflict,
			Record:    recordMap(op.Collection, current),
			Conflicts: []conflictEntry{{Field: "deleted", TheirsBy: current.GetString("modified_by")}},
		}, nil
	}
}

// mergeFields runs §8.3's per-field merge over op.Changed (the `deleted`
// signal excluded) onto current, in field order. It reports the conflicts and
// whether any field applied.
func mergeFields(op pushOp, current *core.Record) (conflicts []conflictEntry, applied bool) {
	for _, field := range sortedFields(op.Changed) {
		if isSignal(field) {
			continue
		}
		newVal := op.Changed[field]
		curVal := jsonCanonical(current.Get(field))
		if curVal == jsonCanonical(newVal) {
			continue // already applied (duplicate delivery, convergent edit)
		}

		// Every changed field needs a base: without one an empty current value
		// would match (empty==empty) and anyone could clobber another member's
		// empty fields. The client's outbox always sends one.
		baseVal, hasBase := op.Base[field]
		if !hasBase || curVal != jsonCanonical(baseVal) {
			// First-committed wins.
			conflicts = append(conflicts, conflictWith(current, field, newVal))
			continue
		}

		current.Set(field, newVal)
		applied = true
		if field == "checked" {
			if !current.GetBool("checked") && notBought(op.Changed) {
				takeBackPurchase(current)
			}
			stampChecked(current, current.GetBool("checked"))
		}
	}
	return conflicts, applied
}

// stampSignals applies the `deleted` signal ([D-45]), stamping deleted_at
// only when the tombstone state actually flips (§8.3). Reports whether it
// changed the row.
func stampSignals(op pushOp, current *core.Record) bool {
	deleted, signalled := op.Changed["deleted"].(bool)
	switch {
	case deleted && tombstone.Living(current):
		current.Set("deleted_at", now())
		return true
	case signalled && !deleted && tombstone.Deleted(current):
		current.Set("deleted_at", "")
		return true
	}
	return false
}

// stampChecked sets the server-owned stamps for a row whose `checked` just
// changed ([D-26]). ONE now() for both: sorting.ts treats them as equal for
// a living checked row, and two calls can straddle a millisecond and leave a
// row on a bucket boundary in neither §6.10 surface. A tick keeps the date it
// replaces in prev_bought_at. Unchecking nulls checked_at ([D-79]) and keeps
// last_bought_at: the purchase is remembered, unless takeBackPurchase ran.
func stampChecked(rec *core.Record, checked bool) {
	if checked {
		ts := now()
		rec.Set("prev_bought_at", rec.GetString("last_bought_at"))
		rec.Set("checked_at", ts)
		rec.Set("last_bought_at", ts)
	} else {
		rec.Set("checked_at", "")
	}
}

// takeBackPurchase restores the purchase date a tick replaced, for an untick
// that says the item was not bought. Only while the purchase is that tick's
// own (last_bought_at still equals its checked_at): one stamped since, by a
// merge or a tick on the removed row, stands.
func takeBackPurchase(rec *core.Record) {
	if rec.GetString("checked_at") == "" || rec.GetString("last_bought_at") != rec.GetString("checked_at") {
		return
	}
	rec.Set("last_bought_at", rec.GetString("prev_bought_at"))
	rec.Set("prev_bought_at", "")
}
