package sync

import (
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// Every `denied` result must carry a reason. The status alone is not actionable:
// the client's response to a denial is to REVERT the optimistic write and drop
// the op (frontend/src/lib/sync/push.ts), and a revert the user cannot be given a
// cause for is the silent data loss this whole path exists to remove.
//
// The reason codes are wire values the client switches on for §12.2 copy, so the
// literals below are deliberately spelled out rather than referencing the
// constants — a rename that does not also update the client should fail here.
func TestPush_Denied_CarriesReason(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	otherList := testutil.CreateListFor(t, app, randid.ID(), "Test")

	// A live row to aim the update-path denials at.
	existingID := randid.ID()
	if r := push(t, mux, tok, []pushOp{{
		OpID:       "seed",
		Collection: collectionItems,
		RecordID:   existingID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("seed create: %v", r)
	}

	cases := []struct {
		name       string
		op         pushOp
		wantReason string
		wantField  string
	}{
		{
			name:       "unknown collection",
			op:         pushOp{Collection: "accounts", RecordID: randid.ID(), ListID: listID, Type: "create"},
			wantReason: "bad_collection",
		},
		{
			name:       "missing list_id",
			op:         pushOp{Collection: collectionItems, RecordID: randid.ID(), Type: "create"},
			wantReason: "bad_list",
		},
		{
			name:       "unknown op type",
			op:         pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "delete"},
			wantReason: "bad_type",
		},
		{
			name: "field outside the allowlist",
			op: pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
				Changed: map[string]any{"modified_by": "someone-else"}},
			wantReason: "field_unknown",
			wantField:  "modified_by",
		},
		{
			name: "field over the contract cap",
			op: pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
				Changed: map[string]any{"note": strings.Repeat("x", 4097)}},
			wantReason: "field_too_long",
			wantField:  "note",
		},
		{
			// [D-40]-era hardening: `deleted`/`checked` coerce silently through
			// boolFromChanged/deletedSignal, and a coerced `deleted: "yes"` reads as a
			// RESTORE. The value shape is validated like the caps.
			name: "mistyped bool signal",
			op: pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
				Changed: map[string]any{"checked": "true"}},
			wantReason: "field_invalid",
			wantField:  "checked",
		},
		{
			// Precedence, pinned: a bad type is only reachable for a KNOWN field,
			// so an unknown field in the same op still denies as field_unknown.
			name: "unknown field beats a mistyped bool in the same op",
			op: pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
				Changed: map[string]any{"zzz": "1", "checked": "true"}},
			wantReason: "field_unknown",
			wantField:  "zzz",
		},
		{
			// ...and a mistyped bool denies before the cap walk's verdict.
			name: "mistyped bool beats an over-cap field in the same op",
			op: pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
				Changed: map[string]any{"checked": "true", "note": strings.Repeat("x", 4097)}},
			wantReason: "field_invalid",
			wantField:  "checked",
		},
		{
			name: "no membership on the target list",
			op: pushOp{Collection: collectionItems, RecordID: randid.ID(), ListID: otherList, Type: "create",
				Changed: map[string]any{"name": "Milk"}},
			wantReason: "not_member",
		},
		{
			name: "row exists but outside the op's scope",
			op: pushOp{Collection: collectionItems, RecordID: existingID, ListID: listID, Type: "update",
				Changed: map[string]any{"name": "Bread"}, Base: map[string]any{"name": "Milk"}},
			wantReason: "wrong_list",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := tc.op
			op.OpID = "denied-" + tc.wantReason

			// The wrong_list case needs the row to live somewhere the caller cannot
			// reach; move it out from under the op rather than building a second list
			// membership just to take it away again.
			if tc.wantReason == "wrong_list" {
				rec, err := app.FindRecordById(collectionItems, existingID)
				if err != nil {
					t.Fatalf("find seeded row: %v", err)
				}
				rec.Set("list", otherList)
				if err := app.SaveNoValidate(rec); err != nil {
					t.Fatalf("move row: %v", err)
				}
			}

			before := storedItem(app, op.RecordID)
			results := push(t, mux, tok, []pushOp{op})
			if len(results) != 1 {
				t.Fatalf("results = %v, want exactly 1", results)
			}
			// A denial writes nothing: a create leaves no row, an update leaves
			// the row as it was.
			if after := storedItem(app, op.RecordID); !reflect.DeepEqual(before, after) {
				t.Errorf("a denied op changed the stored row:\n before %v\n after  %v", before, after)
			}
			got := results[0]
			if got.Status != "denied" {
				t.Fatalf("status = %q, want denied", got.Status)
			}
			if got.Reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", got.Reason, tc.wantReason)
			}
			if got.Field != tc.wantField {
				t.Errorf("field = %q, want %q", got.Field, tc.wantField)
			}
		})
	}
}

// The [D-30] Others protection is the one denial a user reaches through normal
// UI (the category editor's delete button), so it gets its own case. The client
// reverts the optimistic tombstone on this reason, which is the behaviour that
// makes the row reappear instead of vanishing locally forever.
func TestPush_Denied_OthersProtection_CarriesReason(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	otherID := seedOtherCategory(t, app, listID)

	results := push(t, mux, tok, []pushOp{{
		OpID:       "kill-others",
		Collection: collectionCategories,
		RecordID:   otherID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}})
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}
	if results[0].Reason != "protected_row" {
		t.Errorf("reason = %q, want protected_row", results[0].Reason)
	}
	if results[0].Field != "deleted" {
		t.Errorf("field = %q, want deleted", results[0].Field)
	}
}

// storedItem is an item row's stored fields, or nil when there is none.
func storedItem(app core.App, id string) map[string]any {
	rec, err := app.FindRecordById(collectionItems, id)
	if err != nil {
		return nil
	}
	return rec.FieldsData()
}
