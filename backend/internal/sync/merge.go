package sync

import (
	"cmp"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/normalize"
	"shoppinglist/internal/records"
	"shoppinglist/internal/tombstone"
)

// mergedResult answers an op that a [D-29] merge settled. Merges only happen
// on items.
func mergedResult(op pushOp, survivor *core.Record, conflicts []conflictEntry) pushResult {
	return pushResult{
		OpID:      op.OpID,
		Status:    statusMerged,
		RecordID:  survivor.Id,
		Record:    itemRecordMap(survivor),
		Conflicts: conflicts,
	}
}

// conflictWith is the §8.4 toast entry for field: the op's value against the
// row's current one.
func conflictWith(rec *core.Record, field string, mine any) conflictEntry {
	return conflictEntry{
		Field:    field,
		Mine:     mine,
		Theirs:   rec.Get(field),
		TheirsBy: rec.GetString("modified_by"),
	}
}

// conflictsFor lists the fields of changed whose non-empty value differs
// from item's, in field order, skipping the merge-internal ones.
func conflictsFor(item *core.Record, changed map[string]any) []conflictEntry {
	var conflicts []conflictEntry
	for _, field := range sortedFields(changed) {
		if isSignal(field) || field == "name" || field == "checked" || field == "list" {
			continue
		}
		newVal := jsonCanonical(changed[field])
		if jsonCanonical(item.Get(field)) != newVal && newVal != "" {
			conflicts = append(conflicts, conflictWith(item, field, changed[field]))
		}
	}
	return conflicts
}

// fillBlanks gives a merge's survivor the op's quantity, note and barcode
// where its own are blank ([D-29]): a blank is not a value, so it neither
// beats the op's nor raises a conflict that quotes nothing. A survivor's own
// value still wins. A barcode filled in brings its photo on save ([D-266],
// barcode.Register): a scan merged into a typed item gives it both.
func fillBlanks(survivor *core.Record, changed map[string]any) {
	for _, field := range []string{"quantity", "note", "barcode"} {
		if v := stringFromChanged(changed, field); v != "" && survivor.GetString(field) == "" {
			survivor.Set(field, v)
		}
	}
}

// applyCheckIntent is the check state a [D-29]/[D-176] merge leaves on its
// survivor: checked if the op checks it, otherwise re-activated — the row was
// bought and is being added again. An op that checks is a purchase now, also
// on a survivor still checked from an earlier trip: its old stamps would file
// today's purchase under "Frühere Artikel" ([D-108]).
func applyCheckIntent(survivor *core.Record, wantsChecked bool) {
	if wantsChecked || survivor.GetBool("checked") {
		survivor.Set("checked", wantsChecked)
		stampChecked(survivor, wantsChecked)
	}
}

// sameNameItems is every items row on the list carrying the [D-29] merge key
// norm, oldest first and the lower id first within a millisecond (§8.3), so
// "first-committed wins" picks the same survivor even if two same-name rows
// ever coexist.
func sameNameItems(txApp core.App, listID, norm string) ([]*core.Record, error) {
	rows, err := txApp.FindAllRecords(collectionItems, dbx.HashExp{"list": listID, "name_norm": norm})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(rows, func(a, b *core.Record) int {
		return cmp.Or(strings.Compare(a.GetString("created"), b.GetString("created")), strings.Compare(a.Id, b.Id))
	})
	return rows, nil
}

// remembersPurchase reports whether a tombstoned item is still part of the
// list's §6.10 history ("Frühere Artikel"): it was bought before it was
// removed.
func remembersPurchase(rec *core.Record) bool {
	return !rec.GetDateTime("last_bought_at").IsZero()
}

// mergeByNormalizedName implements the [D-29] duplicate-name create-merge
// into an existing item on the same list. Returns (result, false) when no
// match exists, so the caller falls through to a fresh insert.
func mergeByNormalizedName(txApp core.App, op pushOp, callerID string) (pushResult, bool, error) {
	// The key the save hook stores for the name (Register).
	items, err := sameNameItems(txApp, op.ListID, normalize.Name(stringFromChanged(op.Changed, "name")))
	if err != nil {
		// Abort rather than insert a row the merge might have merged into.
		return pushResult{}, false, err
	}
	// TWO passes, living first: a single created-order pass would let an OLDER
	// tombstone beat a younger living row and leave two of the name listed. A
	// tombstone is a merge target only when the list remembers buying it
	// ([D-29], amended), as in the client's dedup; a never-bought one is gone.
	for _, target := range []func(*core.Record) bool{tombstone.Living, remembersPurchase} {
		if i := slices.IndexFunc(items, target); i >= 0 {
			return mergeInto(txApp, op, items[i], callerID)
		}
	}
	return pushResult{}, false, nil
}

// mergeInto merges a create op into item, its [D-29] survivor.
func mergeInto(txApp core.App, op pushOp, item *core.Record, callerID string) (pushResult, bool, error) {
	fillBlanks(item, op.Changed)
	conflicts := conflictsFor(item, op.Changed)

	// A checked or remembered survivor comes back as the item just added,
	// with the create's quantity and note and no conflict for them ([D-200]).
	// A living, unchecked survivor keeps every field.
	if item.GetBool("checked") || tombstone.Deleted(item) {
		conflicts = slices.DeleteFunc(conflicts, func(c conflictEntry) bool {
			return c.Field == "quantity" || c.Field == "note"
		})
		item.Set("quantity", stringFromChanged(op.Changed, "quantity"))
		item.Set("note", stringFromChanged(op.Changed, "note"))
	}

	if boolFromChanged(op.Changed, "deleted") {
		// Added and removed again offline: do not resurrect it.
		if tombstone.Living(item) {
			item.Set("deleted_at", now())
		}
	} else if tombstone.Deleted(item) {
		item.Set("deleted_at", "")
	}
	return settleMerge(txApp, op, item, callerID, conflicts)
}

// mergeRestore extends the [D-29] duplicate-name merge to a tombstone being
// restored while a living row of the same name exists ([D-176]). The living
// row survives, as in mergeByNormalizedName; the purchase memory moves to it,
// so the tombstone no longer shows as a separate history entry. Logged in
// merge_log under the tombstone's id ([D-108]). Returns (result, false) when
// no living twin exists: the caller then lifts the tombstone.
func mergeRestore(txApp core.App, op pushOp, tomb *core.Record, callerID string) (pushResult, bool, error) {
	if replayed, ok, err := replayMerge(txApp, op); err != nil || ok {
		return replayed, ok, err
	}
	// Keyed on the name, not the stored name_norm: a row the dashboard wrote
	// before the save hook stamped it has an empty one, which would match
	// every other such row.
	rows, err := sameNameItems(txApp, op.ListID, normalize.Name(tomb.GetString("name")))
	if err != nil {
		return pushResult{}, false, err
	}
	i := slices.IndexFunc(rows, func(r *core.Record) bool {
		return r.Id != tomb.Id && tombstone.Living(r)
	})
	if i < 0 {
		return pushResult{}, false, nil
	}
	survivor := rows[i]

	fillBlanks(survivor, op.Changed)
	conflicts := conflictsFor(survivor, op.Changed)
	if bought := tomb.GetDateTime("last_bought_at"); bought.After(survivor.GetDateTime("last_bought_at")) {
		survivor.Set("last_bought_at", bought)
	}
	tomb.Set("last_bought_at", "")
	tomb.Set("modified_by", callerID)
	if err := txApp.SaveNoValidate(tomb); err != nil {
		return pushResult{}, false, err
	}
	return settleMerge(txApp, op, survivor, callerID, conflicts)
}

// settleMerge ends every [D-29] merge: the op's check intent on the survivor,
// which is saved, and the given-up id logged so a retry replays instead of
// merging twice ([D-108]). Same transaction as the merge, so neither exists
// without the other.
func settleMerge(txApp core.App, op pushOp, survivor *core.Record, callerID string, conflicts []conflictEntry) (pushResult, bool, error) {
	// The op may carry the caller's OWN coalesced post-create edits (§8.2
	// step 3); re-activation must not overrule them ([D-108]).
	applyCheckIntent(survivor, boolFromChanged(op.Changed, "checked"))
	survivor.Set("modified_by", callerID)
	if err := txApp.SaveNoValidate(survivor); err != nil {
		return pushResult{}, false, err
	}
	if err := recordMerge(txApp, op, survivor.Id); err != nil {
		return pushResult{}, false, err
	}
	return mergedResult(op, survivor, conflicts), true, nil
}

// recordMerge stores the (discarded create id → survivor) mapping that makes a
// [D-29] merge retry-safe ([D-108]). Keyed by the discarded id, so the replay
// lookup that runs per create op is a primary-key hit.
func recordMerge(txApp core.App, op pushOp, survivorID string) error {
	col, err := txApp.FindCachedCollectionByNameOrId("merge_log")
	if err != nil {
		return err
	}
	rec := core.NewRecord(col)
	rec.Id = op.RecordID
	rec.Set("list", op.ListID)
	rec.Set("survivor", survivorID)
	rec.Set("op_id", op.OpID)
	rec.Set("merged_at", now())
	return txApp.SaveNoValidate(rec)
}

// replayMerge answers a retry of a create or restore this list already
// merged, WITHOUT re-running the merge's side effects (the second half of
// [D-42]: a merged create has no row under its id). Returns (result, true)
// when the log knows this id from this op and its survivor still exists. A
// different op on a logged id is a new restore of the same tombstone, not a
// retry: its stale row goes and the merge runs again ([D-176]). An id another
// list logged is answered like an id another list's row holds: denied, and
// that list's row is left alone (the membership check covered only op.ListID).
func replayMerge(txApp core.App, op pushOp) (pushResult, bool, error) {
	logged, err := records.FindOptional(txApp, "merge_log", op.RecordID)
	if err != nil || logged == nil {
		return pushResult{}, false, err
	}
	if logged.GetString("list") != op.ListID {
		return denied(op, reasonBadRecordID), true, nil
	}
	var survivor *core.Record
	// A row logged before op ids were kept has none, and answers as before.
	if opID := logged.GetString("op_id"); opID == "" || opID == op.OpID {
		if survivor, err = records.FindOptional(txApp, collectionItems, logged.GetString("survivor")); err != nil {
			return pushResult{}, false, err
		}
	}
	if survivor == nil {
		// Another op's or survivor gone: fall through to the normal path (not
		// `gone`, which purges the whole list, §8.6). Drop the stale row first,
		// or a merge on that path could never log itself under this id.
		return pushResult{}, false, txApp.Delete(logged)
	}
	// Conflicts are recomputed against the survivor as it is now.
	return mergedResult(op, survivor, conflictsFor(survivor, op.Changed)), true, nil
}
