package sync

import (
	"fmt"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

func createOp(listID, name string) pushOp {
	return pushOp{
		OpID:       randid.ID(),
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": name},
	}
}

// A create that would add a row past the cap is denied list_full, and nothing
// is stored; the creates under it apply.
func TestListCap_CreateOverCapDenied(t *testing.T) {
	app, mux := setupSyncAppWith(t, listcap.Caps{Items: 2})
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	over := createOp(listID, "Bread")
	results := push(t, mux, tok, []pushOp{createOp(listID, "Milk"), createOp(listID, "Eggs"), over})
	if len(results) != 3 {
		t.Fatalf("results = %v, want 3", results)
	}
	for i, want := range []pushStatus{statusApplied, statusApplied, statusDenied} {
		if results[i].Status != want {
			t.Errorf("results[%d].Status = %q, want %q", i, results[i].Status, want)
		}
	}
	if results[2].Reason != reasonListFull {
		t.Errorf("reason = %q, want %q", results[2].Reason, reasonListFull)
	}
	if rec, _ := app.FindRecordById(collectionItems, over.RecordID); rec != nil {
		t.Error("the refused create was stored")
	}
}

// Tombstones are rows: they count toward the cap.
func TestListCap_TombstonesCount(t *testing.T) {
	app, mux := setupSyncAppWith(t, listcap.Caps{Items: 1})
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	testutil.CreateItem(t, app, listID, "Milk", func(r *core.Record) { r.Set("deleted_at", types.NowDateTime()) })

	results := push(t, mux, tok, []pushOp{createOp(listID, "Bread")})
	if len(results) != 1 || results[0].Status != "denied" || results[0].Reason != reasonListFull {
		t.Errorf("results = %v, want denied/list_full", results)
	}
}

// A full list still takes a create that merges into an existing row and a
// duplicate delivery of a create it already stored: neither adds a row.
func TestListCap_FullListStillMergesAndReplays(t *testing.T) {
	app, mux := setupSyncAppWith(t, listcap.Caps{Items: 1})
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	first := createOp(listID, "Milk")
	if r := push(t, mux, tok, []pushOp{first}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("first create = %v, want applied", r)
	}

	results := push(t, mux, tok, []pushOp{first, createOp(listID, "milk")})
	if len(results) != 2 {
		t.Fatalf("results = %v, want 2", results)
	}
	if results[0].Status != "noop" {
		t.Errorf("duplicate delivery = %q, want noop", results[0].Status)
	}
	if results[1].Status != "merged" {
		t.Errorf("same-name create = %q, want merged", results[1].Status)
	}
}

// The cap is per list: one full list does not refuse a create on another.
func TestListCap_PerList(t *testing.T) {
	app, mux := setupSyncAppWith(t, listcap.Caps{Items: 1})
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	full := testutil.CreateListFor(t, app, acctID, "Full")
	other := testutil.CreateListFor(t, app, acctID, "Other")
	testutil.CreateItem(t, app, full, "Milk")

	results := push(t, mux, tok, []pushOp{createOp(other, "Bread")})
	if len(results) != 1 || results[0].Status != "applied" {
		t.Errorf("results = %v, want applied", results)
	}
}

// Categories have their own fixed cap: a create past listcap.MaxCategories
// rows (tombstones included) is denied list_full and stores nothing, and the
// same list still takes an item.
func TestListCap_CategoriesCapped(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	col, _ := app.FindCollectionByNameOrId(collectionCategories)
	have, err := app.CountRecords(collectionCategories, dbx.HashExp{"list": listID})
	if err != nil {
		t.Fatal(err)
	}
	for i := int(have); i < listcap.MaxCategories-1; i++ {
		rec := core.NewRecord(col)
		rec.Set("list", listID)
		rec.Set("name", fmt.Sprintf("Aisle %d", i))
		if i%2 == 0 {
			rec.Set("deleted_at", types.NowDateTime())
		}
		if err := app.SaveNoValidate(rec); err != nil {
			t.Fatal(err)
		}
	}

	catOp := func(name string) pushOp {
		return pushOp{
			OpID: randid.ID(), Collection: collectionCategories, RecordID: randid.ID(),
			ListID: listID, Type: "create", Changed: map[string]any{"name": name},
		}
	}
	last, over := catOp("Last"), catOp("Over")
	results := push(t, mux, tok, []pushOp{last, over, createOp(listID, "Milk")})
	if len(results) != 3 {
		t.Fatalf("results = %v, want 3", results)
	}
	if results[0].Status != statusApplied {
		t.Errorf("the create up to the cap = %q, want applied", results[0].Status)
	}
	if results[1].Status != statusDenied || results[1].Reason != reasonListFull {
		t.Errorf("the create past the cap = %+v, want denied/list_full", results[1])
	}
	if rec, _ := app.FindRecordById(collectionCategories, over.RecordID); rec != nil {
		t.Error("the refused category was stored")
	}
	if results[2].Status != statusApplied {
		t.Errorf("an item on the same list = %q, want applied", results[2].Status)
	}
}
