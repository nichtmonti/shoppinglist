// Package sync implements the §8 sync-engine server routes: push, digest and
// snapshot.
package sync

import (
	"regexp"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/records"
)

// The two collections the sync engine writes.
const (
	collectionItems      = "items"
	collectionCategories = "list_categories"
)

// pushOp is the §8.2 client op shape. checked_at, last_bought_at, deleted_at
// NEVER appear in Changed/Base (all server-stamped by the push route).
type pushOp struct {
	OpID       string         `json:"op_id"`
	Collection string         `json:"collection"` // "items" | "list_categories"
	RecordID   string         `json:"record_id"`
	ListID     string         `json:"list_id"`
	Type       string         `json:"type"` // "create" | "update"
	Changed    map[string]any `json:"changed,omitempty"`
	Base       map[string]any `json:"base,omitempty"`
}

// conflictEntry is §8.3/§8.4 toast copy only — the server has already decided.
type conflictEntry struct {
	Field    string `json:"field"`
	Mine     any    `json:"mine"`
	Theirs   any    `json:"theirs"`
	TheirsBy string `json:"theirs_by"`
}

// pushResult is the §8.3 per-op result. Record is the authoritative server
// row on every settling status; omitted on gone + denied.
//
// A denial is terminal: the client drops the op and reverts the row, and
// Reason (a stable code mapped to §12.2 copy) and Field tell it why.
type pushResult struct {
	OpID      string          `json:"op_id"`
	Status    pushStatus      `json:"status"`
	Conflicts []conflictEntry `json:"conflicts,omitempty"`
	RecordID  string          `json:"record_id,omitempty"` // merged: surviving row id
	Record    map[string]any  `json:"record,omitempty"`
	Reason    string          `json:"reason,omitempty"` // denied only
	Field     string          `json:"field,omitempty"`  // denied only, when field-scoped
}

// pushStatus is a result's §8.3 wire status.
type pushStatus string

const (
	statusApplied         pushStatus = "applied"
	statusPartial         pushStatus = "partial"
	statusNoop            pushStatus = "noop"
	statusMerged          pushStatus = "merged"
	statusDeletedConflict pushStatus = "deleted_conflict"
	statusGone            pushStatus = "gone"
	statusDenied          pushStatus = "denied"
)

// The `denied` reason codes. Stable wire values the client maps to toast copy
// (formatDenied in frontend/src/lib/state/sync-notices.ts, the DeniedReason
// union in frontend/src/lib/sync/types.ts): renaming one breaks older clients.
const (
	reasonBadCollection = "bad_collection" // not items / list_categories
	reasonBadList       = "bad_list"       // missing list_id
	reasonBadType       = "bad_type"       // not create / update
	reasonFieldUnknown  = "field_unknown"  // not in the writable allowlist
	reasonFieldTooLong  = "field_too_long" // over the contract's byte cap
	reasonNotMember     = "not_member"     // no membership row for caller+list
	reasonWrongList     = "wrong_list"     // row exists, outside the op's scope
	reasonProtectedRow  = "protected_row"  // the Others category ([D-30])
	reasonBadRecordID   = "bad_record_id"  // create id outside the [D-08] bound
	reasonRowMissing    = "row_missing"    // row gone but the LIST lives ([D-103])
	reasonFieldInvalid  = "field_invalid"  // a value of the wrong JSON type
	reasonListFull      = "list_full"      // create over the per-list row cap ([D-217])
)

// itemRecordMap returns the canonical client-facing items row.
func itemRecordMap(rec *core.Record) map[string]any {
	return map[string]any{
		"id":             rec.Id,
		"list":           rec.GetString("list"),
		"name":           rec.GetString("name"),
		"name_de":        nullableText(rec, "name_de"),
		"name_en":        nullableText(rec, "name_en"),
		"quantity":       rec.GetString("quantity"),
		"note":           nullableText(rec, "note"),
		"category_key":   nullableText(rec, "category_key"),
		"checked":        rec.GetBool("checked"),
		"checked_at":     nullableText(rec, "checked_at"),
		"last_bought_at": nullableText(rec, "last_bought_at"),
		"barcode":        nullableText(rec, "barcode"),
		"image_url":      nullableText(rec, "image_url"),
		"modified_by":    nullableText(rec, "modified_by"),
		"updated":        rec.GetString("updated"),
		"created":        rec.GetString("created"),
		"deleted_at":     nullableText(rec, "deleted_at"),
	}
}

// categoryRecordMap returns the canonical client-facing list_categories row.
func categoryRecordMap(rec *core.Record) map[string]any {
	return map[string]any{
		"id":         rec.Id,
		"list":       rec.GetString("list"),
		"slug":       nullableText(rec, "slug"),
		"name":       nullableText(rec, "name"),
		"icon":       rec.GetString("icon"),
		"color":      rec.GetString("color"),
		"sort_order": rec.GetInt("sort_order"),
		"updated":    rec.GetString("updated"),
		"created":    rec.GetString("created"),
		"deleted_at": nullableText(rec, "deleted_at"),
	}
}

// nullableText is field's value with an empty one as JSON null.
func nullableText(rec *core.Record, field string) any {
	return records.NullIfEmpty(rec.GetString(field))
}

func recordMap(collection string, rec *core.Record) map[string]any {
	if collection == collectionItems {
		return itemRecordMap(rec)
	}
	return categoryRecordMap(rec)
}

// recordIDPattern bounds the client-minted id a create op may carry ([D-08]).
// The id stays client-minted, since rows are created offline and [D-42]'s
// duplicate-id `noop` makes a re-delivery idempotent, so it is validated
// rather than replaced. Deliberately a BOUND, not a format: clients mint
// UUIDs, the Go side 32 hex (internal/randid), and an unbounded id would
// bloat every member's snapshot and digest.
var recordIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// maxOpIDBytes bounds an op's op_id, which a merge stores in merge_log
// ([D-108]) through SaveNoValidate, past the schema's Max. Clients mint UUIDs.
const maxOpIDBytes = 64
