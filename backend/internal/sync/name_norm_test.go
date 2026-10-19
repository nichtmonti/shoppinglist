package sync

import (
	"testing"

	"shoppinglist/internal/normalize"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// TestPush_NameNorm_StoredAndUpdated: name_norm is a server-owned column
// derived from `name` via normalize.Name (migration 1778000008) — a create
// stores it, and an update that changes `name` recomputes it.
func TestPush_NameNorm_StoredAndUpdated(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// (a) create: name_norm is stored, normalized from the raw name
	itemID := randid.ID()
	results := push(t, mux, tok, []pushOp{{
		OpID: "create", Collection: collectionItems, RecordID: itemID, ListID: listID,
		Type: "create", Changed: map[string]any{"name": "  Two   Words  "},
	}})
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", results)
	}
	rec, _ := app.FindRecordById(collectionItems, itemID)
	if rec == nil {
		t.Fatal("server record not found")
	}
	if got := rec.GetString("name_norm"); got != normalize.Name("  Two   Words  ") {
		t.Errorf("name_norm = %q, want %q", got, normalize.Name("  Two   Words  "))
	}

	// (b) update that changes `name` recomputes name_norm
	results = push(t, mux, tok, []pushOp{{
		OpID: "rename", Collection: collectionItems, RecordID: itemID, ListID: listID,
		Type: "update", Changed: map[string]any{"name": "  Milk   Bottle "},
		Base: map[string]any{"name": "  Two   Words  "},
	}})
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("update status = %v, want applied", results)
	}
	rec, _ = app.FindRecordById(collectionItems, itemID)
	if got := rec.GetString("name_norm"); got != normalize.Name("  Milk   Bottle ") {
		t.Errorf("name_norm after rename = %q, want %q", got, normalize.Name("  Milk   Bottle "))
	}
}
