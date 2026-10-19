package sync

import (
	"testing"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// TestPush_Update_DisjointFieldsMerge: two clients update DIFFERENT fields from the same base → both "applied", both fields present.
func TestPush_Update_DisjointFieldsMerge(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	// Create an item
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	resultsCreate := push(t, mux, tokA, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// A updates quantity
	opsA := []pushOp{{
		OpID:       "updateA",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": "2"},
	}}
	resultsA := push(t, mux, tokA, opsA)
	if len(resultsA) != 1 || resultsA[0].Status != "applied" {
		t.Fatalf("A status = %v, want applied", resultsA)
	}

	// B updates note (different field) from the SAME base
	opsB := []pushOp{{
		OpID:       "updateB",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"note": "Buy organic"},
		Base:       map[string]any{"quantity": "2", "note": ""},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "applied" {
		t.Fatalf("B status = %v, want applied", resultsB)
	}

	// Both fields should be present in final row
	if resultsB[0].Record["quantity"] != "5" {
		t.Errorf("quantity = %v, want 5 (A's change)", resultsB[0].Record["quantity"])
	}
	if resultsB[0].Record["note"] != "Buy organic" {
		t.Errorf("note = %v, want 'Buy organic' (B's change)", resultsB[0].Record["note"])
	}

	// Zero conflicts
	if len(resultsB[0].Conflicts) != 0 {
		t.Errorf("conflicts = %v, want 0", resultsB[0].Conflicts)
	}
}

// TestPush_Update_ConcurrentCheckoff_Converges: two clients both flip checked false→true from base false → BOTH "applied", ZERO conflicts.
func TestPush_Update_ConcurrentCheckoff_Converges(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

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
	resultsCreate := push(t, mux, tokA, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// Both A and B flip checked false→true from base false
	opsA := []pushOp{{
		OpID:       "checkA",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"checked": true},
		Base:       map[string]any{"checked": false},
	}}
	opsB := []pushOp{{
		OpID:       "checkB",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"checked": true},
		Base:       map[string]any{"checked": false},
	}}

	resultsA := push(t, mux, tokA, opsA)
	resultsB := push(t, mux, tokB, opsB)

	// Both should be "applied" (or one applied one noop due to convergent change)
	if resultsA[0].Status != "applied" && resultsA[0].Status != "noop" {
		t.Errorf("A status = %v, want applied or noop", resultsA[0].Status)
	}
	if resultsB[0].Status != "applied" && resultsB[0].Status != "noop" {
		t.Errorf("B status = %v, want applied or noop", resultsB[0].Status)
	}

	// ZERO conflicts reported
	if len(resultsA[0].Conflicts) != 0 {
		t.Errorf("A conflicts = %v, want 0", resultsA[0].Conflicts)
	}
	if len(resultsB[0].Conflicts) != 0 {
		t.Errorf("B conflicts = %v, want 0", resultsB[0].Conflicts)
	}

	// Final state should be checked=true
	serverRec, _ := app.FindRecordById(collectionItems, itemID)
	if !serverRec.GetBool("checked") {
		t.Error("final checked should be true")
	}
}

// TestPush_Update_SameFieldConflict_Partial: A sets quantity "2" (base ""); B sets quantity "5" (base "") AFTER A landed → B's result "partial".
func TestPush_Update_SameFieldConflict_Partial(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

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
	resultsCreate := push(t, mux, tokA, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// A sets quantity "2" (base "")
	opsA := []pushOp{{
		OpID:       "updateA",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "2"},
		Base:       map[string]any{"quantity": ""},
	}}
	resultsA := push(t, mux, tokA, opsA)
	if len(resultsA) != 1 || resultsA[0].Status != "applied" {
		t.Fatalf("A status = %v, want applied", resultsA)
	}

	// B sets quantity "5" (base "") AFTER A landed → B sees "2" as current
	opsB := []pushOp{{
		OpID:       "updateB",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": ""},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "partial" {
		t.Fatalf("B status = %v, want partial", resultsB[0].Status)
	}

	// Should have a conflict
	if len(resultsB[0].Conflicts) != 1 {
		t.Fatalf("conflicts count = %d, want 1", len(resultsB[0].Conflicts))
	}
	c := resultsB[0].Conflicts[0]
	if c.Field != "quantity" {
		t.Errorf("conflict field = %v, want quantity", c.Field)
	}
	if c.Mine != "5" {
		t.Errorf("conflict mine = %v, want 5", c.Mine)
	}
	if c.Theirs != "2" {
		t.Errorf("conflict theirs = %v, want 2", c.Theirs)
	}
	if c.TheirsBy != acctA {
		t.Errorf("conflict theirs_by = %v, want %s", c.TheirsBy, acctA)
	}

	// The row should keep "2" (first-committed wins)
	if resultsB[0].Record["quantity"] != "2" {
		t.Errorf("record quantity = %v, want 2", resultsB[0].Record["quantity"])
	}
}

// TestPush_Update_ReEditAfterConflict_NoLoop: after the conflict above, B immediately re-edits quantity to "9" with base = the server value "2".
func TestPush_Update_ReEditAfterConflict_NoLoop(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

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
	_ = push(t, mux, tokA, opsCreate)

	// A sets quantity "2"
	opsA := []pushOp{{
		OpID:       "updateA",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "2"},
		Base:       map[string]any{"quantity": ""},
	}}
	_ = push(t, mux, tokA, opsA)

	// B sets quantity "5" from base "" → partial conflict
	opsB := []pushOp{{
		OpID:       "updateB",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": ""},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "partial" {
		t.Fatalf("B status = %v, want partial", resultsB[0].Status)
	}

	// B immediately re-edits quantity to "9" with base = the server value "2"
	opsB2 := []pushOp{{
		OpID:       "updateB2",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "9"},
		Base:       map[string]any{"quantity": "2"},
	}}
	resultsB2 := push(t, mux, tokB, opsB2)
	if len(resultsB2) != 1 || resultsB2[0].Status != "applied" {
		t.Fatalf("B2 status = %v, want applied", resultsB2[0].Status)
	}

	// No conflict
	if len(resultsB2[0].Conflicts) != 0 {
		t.Errorf("conflicts = %v, want 0 (no loop)", resultsB2[0].Conflicts)
	}

	// Record should have "9"
	if resultsB2[0].Record["quantity"] != "9" {
		t.Errorf("record quantity = %v, want 9", resultsB2[0].Record["quantity"])
	}
}

// TestPush_Update_OthersProtection_Denied: update a list_categories row with slug "other" setting deleted:true → status "denied".
func TestPush_Update_OthersProtection_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	catID := seedOtherCategory(t, app, listID)

	// Try to delete "other" category
	ops := []pushOp{{
		OpID:       "delete",
		Collection: collectionCategories,
		RecordID:   catID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}

	// Verify the row's deleted_at stays empty
	serverRec, _ := app.FindRecordById(collectionCategories, catID)
	if serverRec.GetString("deleted_at") != "" {
		t.Error("deleted_at should be empty (protected)")
	}
}

// TestPush_Update_ConvergentDelete_Noop: A deletes (deleted:true); B also sends deleted:true from before → B's status "noop".
func TestPush_Update_ConvergentDelete_Noop(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

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
	_ = push(t, mux, tokA, opsCreate)

	// A deletes
	opsA := []pushOp{{
		OpID:       "deleteA",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	_ = push(t, mux, tokA, opsA)

	// B also sends deleted:true from before (convergent delete)
	opsB := []pushOp{{
		OpID:       "deleteB",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "noop" {
		t.Fatalf("B status = %v, want noop", resultsB[0].Status)
	}

	// No conflict, no toast
	if len(resultsB[0].Conflicts) != 0 {
		t.Errorf("conflicts = %v, want 0", resultsB[0].Conflicts)
	}
}

// TestPush_Update_DeletedConflict: A deletes (deleted:true); B sends a quantity edit (NOT touching deleted) after → B's status "deleted_conflict".
func TestPush_Update_DeletedConflict(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	// Create an item
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	_ = push(t, mux, tokA, opsCreate)

	// A deletes
	opsA := []pushOp{{
		OpID:       "deleteA",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	_ = push(t, mux, tokA, opsA)

	// B sends a quantity edit (NOT touching deleted) after
	opsB := []pushOp{{
		OpID:       "updateB",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"quantity": "5"},
		Base:       map[string]any{"quantity": "2"},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "deleted_conflict" {
		t.Fatalf("B status = %v, want deleted_conflict", resultsB[0].Status)
	}
	// The edit is not written onto the removed row.
	if rec, _ := app.FindRecordById(collectionItems, itemID); rec.GetString("quantity") != "2" || rec.GetString("deleted_at") == "" {
		t.Errorf("stored row = quantity %q deleted_at %q, want 2 and still deleted", rec.GetString("quantity"), rec.GetString("deleted_at"))
	}

	// Should have a conflict with theirs_by
	if len(resultsB[0].Conflicts) != 1 {
		t.Fatalf("conflicts count = %d, want 1", len(resultsB[0].Conflicts))
	}
	c := resultsB[0].Conflicts[0]
	if c.Field != "deleted" {
		t.Errorf("conflict field = %v, want deleted", c.Field)
	}
	if c.TheirsBy != acctA {
		t.Errorf("theirs_by = %v, want %s", c.TheirsBy, acctA)
	}

	// B's record should reflect the tombstoned row
	if resultsB[0].Record["deleted_at"] == nil {
		t.Error("record should show deleted_at non-nil (tombstoned)")
	}
}

// TestPush_Update_Restore: B sends deleted:false on a tombstoned row → status "applied", record.deleted_at == nil.
func TestPush_Update_Restore(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create and delete an item
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

	opsDelete := []pushOp{{
		OpID:       "delete",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	_ = push(t, mux, tok, opsDelete)

	// Restore with deleted:false
	opsRestore := []pushOp{{
		OpID:       "restore",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": false},
	}}
	resultsRestore := push(t, mux, tok, opsRestore)
	if len(resultsRestore) != 1 || resultsRestore[0].Status != "applied" {
		t.Fatalf("status = %v, want applied", resultsRestore[0].Status)
	}

	// record.deleted_at should be nil
	if resultsRestore[0].Record["deleted_at"] != nil {
		t.Error("record deleted_at should be nil after restore")
	}
}

// TestPush_Update_MissingBase_Conflicts: updating a field without base coverage
// results in a conflict, even when the current value is empty. This prevents
// silent clobbering of another member's empty fields.
func TestPush_Update_MissingBase_Conflicts(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create an item with an empty note
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "note": ""},
	}}
	resultsCreate := push(t, mux, tok, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// Try to update note WITHOUT base coverage (Base is nil)
	opsUpdate := []pushOp{{
		OpID:       "update",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"note": "x"},
		Base:       nil, // No base coverage!
	}}
	resultsUpdate := push(t, mux, tok, opsUpdate)
	if len(resultsUpdate) != 1 || resultsUpdate[0].Status != "partial" {
		t.Fatalf("update status = %v, want partial", resultsUpdate)
	}

	// Should have a conflict on "note"
	if len(resultsUpdate[0].Conflicts) != 1 {
		t.Fatalf("conflicts count = %d, want 1", len(resultsUpdate[0].Conflicts))
	}
	c := resultsUpdate[0].Conflicts[0]
	if c.Field != "note" {
		t.Errorf("conflict field = %v, want note", c.Field)
	}
	if c.Mine != "x" {
		t.Errorf("conflict mine = %v, want x", c.Mine)
	}

	// The stored note should STILL be empty (not clobbered)
	serverRec, _ := app.FindRecordById(collectionItems, itemID)
	if serverRec.GetString("note") != "" {
		t.Errorf("note = %q, want empty (not clobbered)", serverRec.GetString("note"))
	}
}

// TestPush_Update_BasePresent_StillApplies: updating a field with proper base
// coverage (base matches current) still applies correctly. This is a regression
// guard that the new base-coverage logic doesn't break legitimate flows.
func TestPush_Update_BasePresent_StillApplies(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create an item with an empty note
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "note": ""},
	}}
	resultsCreate := push(t, mux, tok, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// Update note WITH proper base coverage (base.note == "" matches current)
	opsUpdate := []pushOp{{
		OpID:       "update",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"note": "x"},
		Base:       map[string]any{"note": ""}, // Proper base coverage
	}}
	resultsUpdate := push(t, mux, tok, opsUpdate)
	if len(resultsUpdate) != 1 || resultsUpdate[0].Status != "applied" {
		t.Fatalf("update status = %v, want applied", resultsUpdate)
	}

	// No conflicts
	if len(resultsUpdate[0].Conflicts) != 0 {
		t.Errorf("conflicts = %v, want 0", resultsUpdate[0].Conflicts)
	}

	// The stored note should be "x" (applied)
	serverRec, _ := app.FindRecordById(collectionItems, itemID)
	if serverRec.GetString("note") != "x" {
		t.Errorf("note = %q, want x (applied)", serverRec.GetString("note"))
	}
}
