package sync

import (
	"errors"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// TestPush_Unauthenticated: no Authorization → 401.
func TestPush_Unauthenticated(t *testing.T) {
	_, mux := setupSyncApp(t)
	body := `{"ops": [{"op_id":"test","collection":"items","record_id":"id","list_id":"lid","type":"create"}]}`
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/sync/push", body, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

// TestPush_Denied_NonMember: caller has no membership on op.ListID → result status "denied".
func TestPush_Denied_NonMember(t *testing.T) {
	app, mux := setupSyncApp(t)
	_, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, randid.ID(), "Test") // a list owned by some other account

	ops := []pushOp{{
		OpID:       "test",
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "denied" {
		t.Errorf("status = %v, want denied", results)
	}
}

// TestPush_Create_Applied: member creates an item: status "applied"; the returned record has name/quantity/list/modified_by==caller.
func TestPush_Create_Applied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	itemID := randid.ID()
	ops := []pushOp{{
		OpID:       "test",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("status = %v, want applied", results)
	}

	rec := results[0].Record
	if rec["name"] != "Milk" {
		t.Errorf("name = %v, want Milk", rec["name"])
	}
	if rec["quantity"] != "2" {
		t.Errorf("quantity = %v, want 2", rec["quantity"])
	}
	if rec["list"] != listID {
		t.Errorf("list = %v, want %s", rec["list"], listID)
	}
	if rec["modified_by"] != acctID {
		t.Errorf("modified_by = %v, want %s", rec["modified_by"], acctID)
	}

	// Verify server row
	serverRec, _ := app.FindRecordById(collectionItems, itemID)
	if serverRec == nil {
		t.Fatal("server record not found")
	}
	if serverRec.GetString("modified_by") != acctID {
		t.Errorf("server modified_by = %v, want %s", serverRec.GetString("modified_by"), acctID)
	}
	// checked false ⇒ checked_at empty, last_bought_at empty
	if serverRec.GetString("checked_at") != "" {
		t.Errorf("checked_at should be empty, got %s", serverRec.GetString("checked_at"))
	}
	if serverRec.GetString("last_bought_at") != "" {
		t.Errorf("last_bought_at should be empty, got %s", serverRec.GetString("last_bought_at"))
	}
}

// TestPush_Create_CheckedStamps: create with checked:true → record.checked_at and last_bought_at are non-empty (server-stamped).
func TestPush_Create_CheckedStamps(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	itemID := randid.ID()
	ops := []pushOp{{
		OpID:       "test",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "checked": true},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("status = %v, want applied", results)
	}

	rec := results[0].Record
	if rec["checked"] != true {
		t.Errorf("checked = %v, want true", rec["checked"])
	}
	if rec["checked_at"] == nil {
		t.Error("checked_at should be non-nil")
	}
	if rec["last_bought_at"] == nil {
		t.Error("last_bought_at should be non-nil")
	}

	// Verify server row
	serverRec, _ := app.FindRecordById(collectionItems, itemID)
	if serverRec.GetString("checked_at") == "" {
		t.Error("server checked_at should be non-empty")
	}
	if serverRec.GetString("last_bought_at") == "" {
		t.Error("server last_bought_at should be non-empty")
	}
}

// TestPush_Create_DuplicateRecordID_Noop ([D-42]): two creates with the SAME record_id: first "applied", second "noop" with the same record.
func TestPush_Create_DuplicateRecordID_Noop(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	itemID := randid.ID()
	ops := []pushOp{{
		OpID:       "test1",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("first status = %v, want applied", results)
	}

	// Count before second op
	countBefore, _ := app.CountRecords(collectionItems, dbx.HashExp{"list": listID})

	// Second create with same record_id
	ops2 := []pushOp{{
		OpID:       "test2",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Eggs", "quantity": "12"},
	}}
	results2 := push(t, mux, tok, ops2)
	if len(results2) != 1 || results2[0].Status != "noop" {
		t.Fatalf("second status = %v, want noop", results2)
	}

	// Verify same record returned
	if results2[0].Record["name"] != "Milk" {
		t.Errorf("second result name = %v, want Milk (unchanged)", results2[0].Record["name"])
	}

	// Count after second op (should be same)
	countAfter, _ := app.CountRecords(collectionItems, dbx.HashExp{"list": listID})
	if countAfter != countBefore {
		t.Errorf("count changed from %d to %d, want no change", countBefore, countAfter)
	}
}

// TestPush_Update_Applied: member updates quantity on an existing row: status "applied"; record reflects new value; modified_by==caller.
func TestPush_Update_Applied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create an item first
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	resultsCreate := push(t, mux, tok, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// Update quantity
	opsUpdate := []pushOp{{
		OpID:       "update",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": "2"},
	}}
	resultsUpdate := push(t, mux, tok, opsUpdate)
	if len(resultsUpdate) != 1 || resultsUpdate[0].Status != "applied" {
		t.Fatalf("update status = %v, want applied", resultsUpdate)
	}

	// Record should reflect new value
	if resultsUpdate[0].Record["quantity"] != "5" {
		t.Errorf("quantity = %v, want 5", resultsUpdate[0].Record["quantity"])
	}
	if resultsUpdate[0].Record["modified_by"] != acctID {
		t.Errorf("modified_by = %v, want %s", resultsUpdate[0].Record["modified_by"], acctID)
	}
}

// TestPush_Update_RowMissing_ListAlive ([D-103]): update an item whose row
// doesn't exist while the LIST does (tombstone GC swept it, or a co-member's
// cascade hasn't reached it) → "denied"/row_missing, NOT "gone": gone makes the
// client purge the whole list (§8.6), which would drop every sibling op and
// claim a live list was deleted. The denied path converges instead — the op
// drops, and the next digest+snapshot removes the zombie row.
func TestPush_Update_RowMissing_ListAlive(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Try to update a nonexistent item on a live list
	ops := []pushOp{{
		OpID:       "update",
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": "2"},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}
	if results[0].Reason != reasonRowMissing {
		t.Errorf("reason = %v, want row_missing", results[0].Reason)
	}
	if results[0].Record != nil {
		t.Error("record should be nil for denied status")
	}
}

// TestPush_Update_Gone ([D-103]): the row AND the list are gone (the §7.3
// cascade ran) → "gone", the signal the client's §8.6 whole-list purge is
// sized for. memberships.list is CascadeDelete:false, so a hard-deleted list
// leaves the caller's membership in place long enough for the op to reach the
// list check.
func TestPush_Update_Gone(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Remove the list row via raw SQL: app.Delete refuses while a required
	// memberships reference points at it, and deleting the membership first
	// would turn the op into not_member. This simulates exactly the state the
	// branch exists for — list gone, membership row still in place (the
	// stale-membership window after a §7.3 cascade, or an admin-side removal).
	if _, err := app.DB().
		NewQuery("DELETE FROM lists WHERE id = {:id}").
		Bind(dbx.Params{"id": listID}).
		Execute(); err != nil {
		t.Fatalf("delete list row: %v", err)
	}

	ops := []pushOp{{
		OpID:       "update",
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": "2"},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "gone" {
		t.Fatalf("status = %v, want gone", results)
	}

	// No record field
	if results[0].Record != nil {
		t.Error("record should be nil for gone status")
	}
}

// TestPush_Create_DeadList_Gone: a create for a list that no longer exists →
// "gone" (the client purges §8.6-style, correct for a vanished list) rather
// than storing an orphan row no digest ever probes.
func TestPush_Create_DeadList_Gone(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Raw SQL for the same reason as TestPush_Update_Gone: keep the membership
	// alive so the op reaches the list check, not not_member.
	if _, err := app.DB().
		NewQuery("DELETE FROM lists WHERE id = {:id}").
		Bind(dbx.Params{"id": listID}).
		Execute(); err != nil {
		t.Fatalf("delete list row: %v", err)
	}

	itemID := randid.ID()
	ops := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "gone" {
		t.Fatalf("status = %v, want gone", results)
	}
	if rec, _ := app.FindRecordById(collectionItems, itemID); rec != nil {
		t.Error("no orphan row should be stored for a dead list")
	}
}

// TestPush_Update_CheckedStamps: flip checked false→true → checked_at AND last_bought_at stamped; flip back true→false → checked_at nil, last_bought_at PERSISTS.
func TestPush_Update_CheckedStamps(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create an item
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	_ = push(t, mux, tok, opsCreate)

	// Flip checked false→true
	opsCheck := []pushOp{{
		OpID:       "check",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"checked": true},
		Base:       map[string]any{"checked": false},
	}}
	resultsCheck := push(t, mux, tok, opsCheck)
	if len(resultsCheck) != 1 || resultsCheck[0].Status != "applied" {
		t.Fatalf("check status = %v, want applied", resultsCheck[0].Status)
	}

	// checked_at AND last_bought_at should be stamped
	if resultsCheck[0].Record["checked_at"] == nil {
		t.Error("checked_at should be non-nil after check")
	}
	if resultsCheck[0].Record["last_bought_at"] == nil {
		t.Error("last_bought_at should be non-nil after check")
	}
	boughtAt := resultsCheck[0].Record["last_bought_at"].(string)

	// Flip back true→false
	opsUncheck := []pushOp{{
		OpID:       "uncheck",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"checked": false},
		Base:       map[string]any{"checked": true},
	}}
	resultsUncheck := push(t, mux, tok, opsUncheck)
	if len(resultsUncheck) != 1 || resultsUncheck[0].Status != "applied" {
		t.Fatalf("uncheck status = %v, want applied", resultsUncheck[0].Status)
	}

	// checked_at should be nil
	if resultsUncheck[0].Record["checked_at"] != nil {
		t.Error("checked_at should be nil after uncheck")
	}

	// last_bought_at should PERSIST (non-nil)
	if resultsUncheck[0].Record["last_bought_at"] == nil {
		t.Error("last_bought_at should persist (non-nil)")
	}
	if resultsUncheck[0].Record["last_bought_at"].(string) != boughtAt {
		t.Error("last_bought_at should persist (same value)")
	}
}

// TestPush_Update_RecordBelongsToOtherList_Denied: update op where op.ListID is a
// list the caller IS a member of, but record_id belongs to a DIFFERENT list →
// "denied" per §8.3 step 1 ("the target record must belong to that list").
// Deliberately NOT "gone": `gone` makes the client purge the whole list (§8.6),
// and this row is very much alive.
func TestPush_Update_RecordBelongsToOtherList_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	otherListID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create an item in otherList
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     otherListID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	_ = push(t, mux, tok, opsCreate)

	// Try to update the item from listID (but it belongs to otherList)
	opsUpdate := []pushOp{{
		OpID:       "update",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID, // Different list!
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": ""},
	}}
	results := push(t, mux, tok, opsUpdate)
	if len(results) != 1 || results[0].Status != "denied" || results[0].Reason != reasonWrongList {
		t.Fatalf("results = %v, want denied/%s", results, reasonWrongList)
	}
	if rec, _ := app.FindRecordById(collectionItems, itemID); rec.GetString("quantity") != "" || rec.GetString("list") != otherListID {
		t.Errorf("stored row = quantity %q list %q, want it untouched in the other list", rec.GetString("quantity"), rec.GetString("list"))
	}

	// No record field
	if results[0].Record != nil {
		t.Error("record should be nil for denied status")
	}
}

// TestPush_ServerFailureOmitsResult: a server-side failure must not come back as a
// verdict — the op gets NO result, so the client keeps it queued and retries
// instead of silently dropping the user's edit.
func TestPush_ServerFailureOmitsResult(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, alice, "Test")

	// Fail the insert inside the transaction.
	app.OnRecordCreate(collectionItems).BindFunc(func(e *core.RecordEvent) error {
		return errors.New("injected insert failure")
	})

	results := push(t, mux, tok, []pushOp{{
		OpID: "fail", Collection: collectionItems, RecordID: randid.ID(), ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Bread"},
	}})
	if len(results) != 0 {
		t.Errorf("results = %v, want none (op left queued for retry)", results)
	}
}
