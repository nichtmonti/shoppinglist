package sync

import (
	"errors"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// TestPush_Create_Merged_DuplicateName ([D-29]): create "Milk" qty "2"; then a SECOND client creates "milk " (different case + trailing space, normalizes same) qty "3".
func TestPush_Create_Merged_DuplicateName(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	itemID1 := randid.ID()
	opsA := []pushOp{{
		OpID:       "test1",
		Collection: collectionItems,
		RecordID:   itemID1,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	resultsA := push(t, mux, tokA, opsA)
	if len(resultsA) != 1 || resultsA[0].Status != "applied" {
		t.Fatalf("first status = %v, want applied", resultsA)
	}

	// Second client creates "milk " (normalized same)
	itemID2 := randid.ID()
	opsB := []pushOp{{
		OpID:       "test2",
		Collection: collectionItems,
		RecordID:   itemID2,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk ", "quantity": "3"},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "merged" {
		t.Fatalf("second status = %v, want merged", resultsB)
	}

	// Record ID should be the first row's id
	if resultsB[0].RecordID != itemID1 {
		t.Errorf("merged record_id = %v, want %s", resultsB[0].RecordID, itemID1)
	}

	// Surviving quantity should be "2" (first-committed wins)
	if resultsB[0].Record["quantity"] != "2" {
		t.Errorf("surviving quantity = %v, want 2", resultsB[0].Record["quantity"])
	}

	// Should have a conflict for quantity
	if len(resultsB[0].Conflicts) != 1 {
		t.Fatalf("conflicts count = %d, want 1", len(resultsB[0].Conflicts))
	}
	c := resultsB[0].Conflicts[0]
	if c.Field != "quantity" {
		t.Errorf("conflict field = %v, want quantity", c.Field)
	}
	if c.Mine != "3" {
		t.Errorf("conflict mine = %v, want 3", c.Mine)
	}
	if c.Theirs != "2" {
		t.Errorf("conflict theirs = %v, want 2", c.Theirs)
	}
	if c.TheirsBy != acctA {
		t.Errorf("conflict theirs_by = %v, want %s", c.TheirsBy, acctA)
	}
}

// TestPush_Create_Merged_BlankFieldTakesTheCreatesValue ([D-29]): a blank
// field is not a value. Anna's "Käse" reached the server before her quantity
// did; Bob's offline duplicate merges into it in that window. His quantity and
// note fill the blanks, with no conflict, where they used to lose to nothing
// and the notice quoted an empty value. Anna's quantity, arriving after, meets
// his and is an ordinary conflict naming it.
func TestPush_Create_Merged_BlankFieldTakesTheCreatesValue(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Anna")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	annas := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{OpID: "a-create", Collection: collectionItems, RecordID: annas, ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Käse"}}})[0]; r.Status != "applied" {
		t.Fatalf("Anna's create = %v, want applied", r.Status)
	}

	r := push(t, mux, tokB, []pushOp{{OpID: "b-create", Collection: collectionItems, RecordID: randid.ID(), ListID: listID,
		Type: "create", Changed: map[string]any{"name": "käse", "quantity": "3 Stück", "note": "gerieben"}}})[0]
	if r.Status != "merged" || r.RecordID != annas {
		t.Fatalf("Bob's create = %v into %v, want merged into %s", r.Status, r.RecordID, annas)
	}
	if len(r.Conflicts) != 0 {
		t.Errorf("conflicts = %v, want none: a blank lost nothing", r.Conflicts)
	}
	if r.Record["quantity"] != "3 Stück" || r.Record["note"] != "gerieben" {
		t.Errorf("merged record = quantity %v note %v, want Bob's 3 Stück and gerieben", r.Record["quantity"], r.Record["note"])
	}

	// Anna's quantity, sent before she saw Bob's, now meets it.
	r = push(t, mux, tokA, []pushOp{{OpID: "a-qty", Collection: collectionItems, RecordID: annas, ListID: listID,
		Type: "update", Changed: map[string]any{"quantity": "1 Kilo"}, Base: map[string]any{"quantity": ""}}})[0]
	if r.Status != "partial" || len(r.Conflicts) != 1 {
		t.Fatalf("Anna's quantity = %v %v, want partial with one conflict", r.Status, r.Conflicts)
	}
	if c := r.Conflicts[0]; c.Field != "quantity" || c.Mine != "1 Kilo" || c.Theirs != "3 Stück" || c.TheirsBy != acctB {
		t.Errorf("conflict = %+v, want quantity: mine 1 Kilo, theirs 3 Stück by Bob", c)
	}
	rec, _ := app.FindRecordById(collectionItems, annas)
	if rec.GetString("quantity") != "3 Stück" || rec.GetString("note") != "gerieben" {
		t.Errorf("stored = quantity %q note %q, want 3 Stück and gerieben", rec.GetString("quantity"), rec.GetString("note"))
	}
}

// TestPush_Create_Merged_ScanGivesATypedItemItsBarcode ([D-29], [D-266]): a
// scan merged into an item typed without a barcode fills it, and the photo
// comes with it, with no conflict; an item with a barcode of its own keeps it.
func TestPush_Create_Merged_ScanGivesATypedItemItsBarcode(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Anna")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)
	photo := testutil.SeedProductPhoto(t, app, "3017620422003")
	testutil.SeedProductPhoto(t, app, "4000417025005")

	typed, scanned := randid.ID(), randid.ID()
	push(t, mux, tokA, []pushOp{
		{OpID: "typed", Collection: collectionItems, RecordID: typed, ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Nutella"}},
		{OpID: "scanned", Collection: collectionItems, RecordID: scanned, ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Milch", "barcode": "4000417025005"}},
	})

	results := push(t, mux, tokB, []pushOp{
		{OpID: "b-nutella", Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
			Changed: map[string]any{"name": "nutella", "barcode": "3017620422003"}},
		{OpID: "b-milch", Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Milch", "barcode": "4099999999999"}},
	})
	if results[0].Status != "merged" || len(results[0].Conflicts) != 0 {
		t.Errorf("scan into the typed item = %v %v, want merged with no conflict", results[0].Status, results[0].Conflicts)
	}
	got, _ := app.FindRecordById(collectionItems, typed)
	if got.GetString("barcode") != "3017620422003" || got.GetString("image_url") != photo {
		t.Errorf("typed item = barcode %q photo %q, want the scan's and %q", got.GetString("barcode"), got.GetString("image_url"), photo)
	}
	if results[1].Status != "merged" || len(results[1].Conflicts) != 1 || results[1].Conflicts[0].Field != "barcode" {
		t.Errorf("scan into a barcoded item = %v %v, want merged with the barcode reported", results[1].Status, results[1].Conflicts)
	}
	if got, _ := app.FindRecordById(collectionItems, scanned); got.GetString("barcode") != "4000417025005" {
		t.Errorf("barcoded item's barcode = %q, want its own kept", got.GetString("barcode"))
	}
}

// TestPush_Create_Merged_IdenticalQuantity_Silent: as above but second create qty "2" (same) → "merged", NO conflicts reported.
func TestPush_Create_Merged_IdenticalQuantity_Silent(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	itemID1 := randid.ID()
	opsA := []pushOp{{
		OpID:       "test1",
		Collection: collectionItems,
		RecordID:   itemID1,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "quantity": "2"},
	}}
	resultsA := push(t, mux, tokA, opsA)
	if len(resultsA) != 1 || resultsA[0].Status != "applied" {
		t.Fatalf("first status = %v, want applied", resultsA)
	}

	// Second client creates "milk " with SAME quantity
	itemID2 := randid.ID()
	opsB := []pushOp{{
		OpID:       "test2",
		Collection: collectionItems,
		RecordID:   itemID2,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk ", "quantity": "2"},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "merged" {
		t.Fatalf("second status = %v, want merged", resultsB)
	}

	// NO conflicts reported (omitempty → conflicts absent)
	if len(resultsB[0].Conflicts) != 0 {
		t.Errorf("conflicts count = %d, want 0", len(resultsB[0].Conflicts))
	}
}

// TestPush_Create_Merged_ReactivateChecked: first row created then checked; then a second client creates the same name → re-activated.
func TestPush_Create_Merged_ReactivateChecked(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	itemID1 := randid.ID()
	opsA := []pushOp{{
		OpID:       "test1",
		Collection: collectionItems,
		RecordID:   itemID1,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	resultsA := push(t, mux, tokA, opsA)
	if len(resultsA) != 1 || resultsA[0].Status != "applied" {
		t.Fatalf("first status = %v, want applied", resultsA)
	}

	// Check the item
	opsCheck := []pushOp{{
		OpID:       "check",
		Collection: collectionItems,
		RecordID:   itemID1,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"checked": true},
		Base:       map[string]any{"checked": false},
	}}
	resultsCheck := push(t, mux, tokA, opsCheck)
	if len(resultsCheck) != 1 || resultsCheck[0].Status != "applied" {
		t.Fatalf("check status = %v, want applied", resultsCheck)
	}

	// Verify it's checked and has stamps
	serverRec, _ := app.FindRecordById(collectionItems, itemID1)
	if !serverRec.GetBool("checked") {
		t.Error("item should be checked")
	}
	if serverRec.GetString("checked_at") == "" {
		t.Error("checked_at should be non-empty after check")
	}
	boughtAt := serverRec.GetString("last_bought_at")
	if boughtAt == "" {
		t.Error("last_bought_at should be non-empty after check")
	}

	// Second client creates "milk " (normalized same)
	itemID2 := randid.ID()
	opsB := []pushOp{{
		OpID:       "test2",
		Collection: collectionItems,
		RecordID:   itemID2,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk ", "quantity": "3"},
	}}
	resultsB := push(t, mux, tokB, opsB)
	if len(resultsB) != 1 || resultsB[0].Status != "merged" {
		t.Fatalf("second status = %v, want merged", resultsB)
	}

	// The surviving row should have checked==false and checked_at==nil (re-activated)
	if resultsB[0].Record["checked"] != false {
		t.Errorf("checked = %v, want false after re-activation", resultsB[0].Record["checked"])
	}
	if resultsB[0].Record["checked_at"] != nil {
		t.Errorf("checked_at = %v, want nil after re-activation", resultsB[0].Record["checked_at"])
	}

	// last_bought_at should persist (non-nil)
	if resultsB[0].Record["last_bought_at"] == nil {
		t.Error("last_bought_at should persist (non-nil)")
	}
}

// TestPush_Create_Merged_ReactivatedComesBackPlain: [D-200] a re-add that
// re-activates a checked row brings back the item, not the last trip's quantity
// and note — and says nothing about them, since nothing current was lost. A
// living row the add merges into keeps both (TestPush_Create_Merged_DuplicateName).
func TestPush_Create_Merged_ReactivatedComesBackPlain(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	itemID := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{
		OpID: "add", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "create",
		Changed: map[string]any{"name": "Milk", "quantity": "2", "note": "bio"},
	}}); r[0].Status != "applied" {
		t.Fatalf("add = %v", r)
	}
	if r := push(t, mux, tokA, []pushOp{{
		OpID: "check", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "update",
		Changed: map[string]any{"checked": true}, Base: map[string]any{"checked": false},
	}}); r[0].Status != "applied" {
		t.Fatalf("check = %v", r)
	}

	res := push(t, mux, tokB, []pushOp{{
		OpID: "readd", Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
		Changed: map[string]any{"name": "milk"},
	}})
	if len(res) != 1 || res[0].Status != "merged" {
		t.Fatalf("re-add = %v, want merged", res)
	}
	if got := res[0].Record["quantity"]; got != "" {
		t.Errorf("quantity = %v, want empty on a re-activated row", got)
	}
	if got := res[0].Record["note"]; got != nil && got != "" {
		t.Errorf("note = %v, want empty on a re-activated row", got)
	}
	if len(res[0].Conflicts) != 0 {
		t.Errorf("conflicts = %v, want none: nothing current was lost", res[0].Conflicts)
	}
	if res[0].Record["last_bought_at"] == nil {
		t.Error("last_bought_at should persist")
	}
}

// TestPush_Create_Merged_RevivalKeepsOtherConflicts: [D-200] drops only the
// last trip's quantity and note from a revived row's conflicts. The re-add's
// quantity is taken without a conflict, while a field the survivor keeps (its
// category) and the re-add set differently is still reported, since the
// re-adder's choice did not land.
func TestPush_Create_Merged_RevivalKeepsOtherConflicts(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	itemID := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{
		OpID: "add", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "create",
		Changed: map[string]any{"name": "Milk", "quantity": "2", "category_key": "dairy"},
	}}); r[0].Status != "applied" {
		t.Fatalf("add = %v", r)
	}
	if r := push(t, mux, tokA, []pushOp{{
		OpID: "check", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "update",
		Changed: map[string]any{"checked": true}, Base: map[string]any{"checked": false},
	}}); r[0].Status != "applied" {
		t.Fatalf("check = %v", r)
	}

	res := push(t, mux, tokB, []pushOp{{
		OpID: "readd", Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
		Changed: map[string]any{"name": "milk", "quantity": "3", "category_key": "drinks"},
	}})
	if len(res) != 1 || res[0].Status != "merged" {
		t.Fatalf("re-add = %v, want merged", res)
	}
	if got := res[0].Record["quantity"]; got != "3" {
		t.Errorf("quantity = %v, want the re-add's 3", got)
	}
	if got := res[0].Record["category_key"]; got != "dairy" {
		t.Errorf("category_key = %v, want the survivor's dairy", got)
	}
	if len(res[0].Conflicts) != 1 || res[0].Conflicts[0].Field != "category_key" ||
		res[0].Conflicts[0].Mine != "drinks" || res[0].Conflicts[0].Theirs != "dairy" {
		t.Errorf("conflicts = %+v, want only category_key (mine drinks, theirs dairy)", res[0].Conflicts)
	}
}

// TestPush_Create_Merged_TombstonedNeverBoughtExcluded: tombstone an item that
// was NEVER bought, then create the same name → inserts FRESH (NOT merged).
// [D-29]'s exclusion holds for exactly this case: with no last_bought_at there
// is no §6.10 history entry the create could be colliding with, so the removed
// row really is gone. (The remembered case merges — see the test below.)
func TestPush_Create_Merged_TombstonedNeverBoughtExcluded(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	itemID1 := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID1,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	resultsCreate := push(t, mux, tok, opsCreate)
	if len(resultsCreate) != 1 || resultsCreate[0].Status != "applied" {
		t.Fatalf("create status = %v, want applied", resultsCreate)
	}

	// Tombstone the item
	opsDelete := []pushOp{{
		OpID:       "delete",
		Collection: collectionItems,
		RecordID:   itemID1,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	resultsDelete := push(t, mux, tok, opsDelete)
	if len(resultsDelete) != 1 || resultsDelete[0].Status != "applied" {
		t.Fatalf("delete status = %v, want applied", resultsDelete)
	}

	// Verify tombstoned
	serverRec, _ := app.FindRecordById(collectionItems, itemID1)
	if serverRec.GetString("deleted_at") == "" {
		t.Error("item should be tombstoned (deleted_at non-empty)")
	}

	// Create the same name again - should be a FRESH insert, not a merge
	itemID2 := randid.ID()
	opsCreate2 := []pushOp{{
		OpID:       "create2",
		Collection: collectionItems,
		RecordID:   itemID2,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk "},
	}}
	resultsCreate2 := push(t, mux, tok, opsCreate2)
	if len(resultsCreate2) != 1 || resultsCreate2[0].Status != "applied" {
		t.Fatalf("second create status = %v, want applied (fresh insert)", resultsCreate2)
	}

	// Should be a NEW record, not merged
	if resultsCreate2[0].Record["id"] != itemID2 {
		t.Errorf("new record id = %v, want %s (fresh insert)", resultsCreate2[0].Record["id"], itemID2)
	}

	// Count should be 2 (original tombstoned + new fresh)
	count, _ := app.CountRecords(collectionItems, dbx.HashExp{"list": listID})
	if count != 2 {
		t.Errorf("count = %d, want 2 (tombstoned + fresh)", count)
	}
}

// TestPush_Create_Merged_TombstonedRememberedMerges: a tombstoned row the list
// still REMEMBERS BUYING is a merge target — it is showing under "Frühere
// Artikel" right now, so a typed re-add must land on THAT row instead of
// inserting a duplicate beside its own history entry. The merge lifts the
// tombstone; last_bought_at survives. ([D-29], amended.)
func TestPush_Create_Merged_TombstonedRememberedMerges(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	itemID1 := randid.ID()
	step := func(name string, op pushOp) pushResult {
		t.Helper()
		results := push(t, mux, tok, []pushOp{op})
		if len(results) != 1 || results[0].Status != "applied" {
			t.Fatalf("%s status = %v, want applied", name, results)
		}
		return results[0]
	}
	update := func(name string, changed, base map[string]any) pushResult {
		t.Helper()
		return step(name, pushOp{
			OpID: name, Collection: collectionItems, RecordID: itemID1,
			ListID: listID, Type: "update", Changed: changed, Base: base,
		})
	}

	step("create", pushOp{
		OpID: "create", Collection: collectionItems, RecordID: itemID1,
		ListID: listID, Type: "create", Changed: map[string]any{"name": "Butter"},
	})
	// Bought (stamps checked_at + last_bought_at), then re-added from history
	// (nulls checked_at, last_bought_at persists), then removed again — the
	// sequence that must not erase the row from "Frühere Artikel".
	update("check", map[string]any{"checked": true}, map[string]any{"checked": false})
	update("uncheck", map[string]any{"checked": false}, map[string]any{"checked": true})
	update("delete", map[string]any{"deleted": true}, nil)

	before, _ := app.FindRecordById(collectionItems, itemID1)
	if before.GetString("deleted_at") == "" {
		t.Fatal("item should be tombstoned before the merge")
	}
	if before.GetString("last_bought_at") == "" {
		t.Fatal("last_bought_at should have survived the uncheck + delete")
	}

	itemID2 := randid.ID()
	results := push(t, mux, tok, []pushOp{{
		OpID: "create2", Collection: collectionItems, RecordID: itemID2,
		ListID: listID, Type: "create", Changed: map[string]any{"name": "butter "},
	}})
	if len(results) != 1 || results[0].Status != "merged" {
		t.Fatalf("second create status = %v, want merged", results)
	}
	if results[0].RecordID != itemID1 {
		t.Errorf("merged into %s, want the remembered row %s", results[0].RecordID, itemID1)
	}
	if results[0].Record["deleted_at"] != nil {
		t.Errorf("deleted_at = %v, want nil — the merge must lift the tombstone", results[0].Record["deleted_at"])
	}
	if results[0].Record["last_bought_at"] == nil {
		t.Error("last_bought_at must persist through the merge")
	}

	// One row, not two: the whole point is that no duplicate is inserted.
	count, _ := app.CountRecords(collectionItems, dbx.HashExp{"list": listID})
	if count != 1 {
		t.Errorf("count = %d, want 1 (merged into the remembered row)", count)
	}
}

// TestPush_Create_Merged_LivingBeatsRememberedTombstone: when one name exists
// both ON the list and in its history, the merge takes the LIVING row — even
// though the tombstone is older and "first-committed wins" ranks by `created`.
// Restoring the older tombstone instead would put two rows of the same name on
// the list, which is the duplication [D-29] exists to prevent. ([D-18])
func TestPush_Create_Merged_LivingBeatsRememberedTombstone(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// A, created FIRST: bought, re-added, then removed — a remembered tombstone.
	itemA := randid.ID()
	send := func(name string, op pushOp) {
		t.Helper()
		results := push(t, mux, tok, []pushOp{op})
		if len(results) != 1 || results[0].Status != "applied" {
			t.Fatalf("%s status = %v, want applied", name, results)
		}
	}
	send("create", pushOp{
		OpID: "create", Collection: collectionItems, RecordID: itemA,
		ListID: listID, Type: "create", Changed: map[string]any{"name": "Milch"},
	})
	for _, step := range []struct {
		name          string
		changed, base map[string]any
	}{
		{"check", map[string]any{"checked": true}, map[string]any{"checked": false}},
		{"uncheck", map[string]any{"checked": false}, map[string]any{"checked": true}},
		{"delete", map[string]any{"deleted": true}, nil},
	} {
		send(step.name, pushOp{
			OpID: step.name, Collection: collectionItems, RecordID: itemA,
			ListID: listID, Type: "update", Changed: step.changed, Base: step.base,
		})
	}

	// B, created SECOND and living. Two same-name rows coexist only after a
	// concurrent insert (§8.3) — and that state can no longer be reached through
	// push, since a create would merge into A. So B goes in directly.
	col, err := app.FindCollectionByNameOrId(collectionItems)
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}
	recB := core.NewRecord(col)
	recB.Set("list", listID)
	recB.Set("name", "Milch")
	if err := app.SaveNoValidate(recB); err != nil {
		t.Fatalf("insert living duplicate: %v", err)
	}

	results := push(t, mux, tok, []pushOp{{
		OpID: "create2", Collection: collectionItems, RecordID: randid.ID(),
		ListID: listID, Type: "create", Changed: map[string]any{"name": "milch "},
	}})
	if len(results) != 1 || results[0].Status != "merged" {
		t.Fatalf("status = %v, want merged", results)
	}
	if results[0].RecordID != recB.Id {
		t.Errorf("merged into %s, want the LIVING row %s (tombstone is older)", results[0].RecordID, recB.Id)
	}

	// A stays removed — nothing resurrected it.
	recA, err := app.FindRecordById(collectionItems, itemA)
	if err != nil {
		t.Fatalf("find A: %v", err)
	}
	if recA.GetString("deleted_at") == "" {
		t.Error("the older tombstone was resurrected; the living row should have won")
	}
}

// failingSaveApp is a core.App stub whose SaveNoValidate always fails; the
// remaining interface methods come from the embedded nil App (none of them are
// reached on the merge path). The real DB cannot be forced into a
// deterministic merge-save failure — the merge re-saves a row that already
// exists, so no constraint can trip — so this stub is the only way to pin the
// error branch of mergeByNormalizedName. `list` satisfies [D-103]'s dead-list
// gate, which consults FindRecordById("lists") before the merge runs.
type failingSaveApp struct {
	core.App
	items []*core.Record
	list  *core.Record
}

func (f *failingSaveApp) RunInTransaction(fn func(core.App) error) error { return fn(f) }

func (f *failingSaveApp) FindRecordById(collectionModelOrIdentifier any, recordId string, optFilters ...func(q *dbx.SelectQuery) error) (*core.Record, error) {
	if collectionModelOrIdentifier == "lists" {
		return f.list, nil
	}
	return nil, nil
}

func (f *failingSaveApp) FindAllRecords(collectionModelOrIdentifier any, exprs ...dbx.Expression) ([]*core.Record, error) {
	return f.items, nil
}

func (f *failingSaveApp) SaveNoValidate(model core.Model) error {
	return errors.New("injected save failure")
}

// TestPush_Create_MergeSaveFailure_Retries: a save failure INSIDE the [D-29]
// merge (as opposed to the fresh insert, which TestPush_ServerFailureOmitsResult
// covers) must abort the transaction and leave the op queued — the create must
// NOT degrade to inserting a duplicate-named row because the merge stumbled.
func TestPush_Create_MergeSaveFailure_Retries(t *testing.T) {
	app, _ := setupSyncApp(t)
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}
	// A live row whose normalized name matches the op, so the merge matches.
	match := core.NewRecord(col)
	match.Id = randid.ID()
	match.Set("name", "Milk")

	// A living list record so [D-103]'s dead-list gate lets the op through to
	// the merge this test is about.
	listCol, err := app.FindCollectionByNameOrId("lists")
	if err != nil {
		t.Fatalf("find lists collection: %v", err)
	}
	listRec := core.NewRecord(listCol)
	listRec.Id = "listA"

	result, err := processCreate(&failingSaveApp{items: []*core.Record{match}, list: listRec}, pushOp{
		OpID: "m", Collection: collectionItems, RecordID: randid.ID(), ListID: "listA",
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}, "caller1", listcap.Default().Items)
	if err == nil {
		t.Errorf("status = %q, want an error: a merge save failure must abort the transaction, not fall through to an insert", result.Status)
	}
}

// failingQueryApp is a core.App stub whose queries always fail; the remaining
// interface methods come from the embedded nil App (none of them are reached
// once a query aborts the transaction). FindRecordById fails too — [D-103]'s
// dead-list gate consults it before the merge, and an injected failure there
// must abort exactly like the merge's own lookup does.
type failingQueryApp struct {
	core.App
}

func (f *failingQueryApp) RunInTransaction(fn func(core.App) error) error { return fn(f) }

func (f *failingQueryApp) FindRecordById(collectionModelOrIdentifier any, recordId string, optFilters ...func(q *dbx.SelectQuery) error) (*core.Record, error) {
	return nil, errors.New("injected lookup failure")
}

func (f *failingQueryApp) FindAllRecords(collectionModelOrIdentifier any, exprs ...dbx.Expression) ([]*core.Record, error) {
	return nil, errors.New("injected query failure")
}

// TestPush_Create_MergeQueryFailure_Retries: a FindAllRecords failure inside
// the [D-29] merge must abort the transaction and leave the op queued — the
// create must NOT degrade to inserting a duplicate-named row when the
// duplicate check itself could not run.
func TestPush_Create_MergeQueryFailure_Retries(t *testing.T) {
	result, err := processCreate(&failingQueryApp{}, pushOp{
		OpID: "q", Collection: collectionItems, RecordID: randid.ID(), ListID: "listA",
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}, "caller1", listcap.Default().Items)
	if err == nil {
		t.Errorf("status = %q, want an error: a merge lookup failure must abort the transaction, not fall through to an insert", result.Status)
	}
}

// TestPush_Create_Merged_RetryReplaysWithoutReactivating is the [D-108] replay
// check ([D-42]'s promise, extended to the merge path). B's duplicate-name
// create is MERGED and the response is lost; A then checks the survivor off; B
// retries the identical op. Before the merge log, B's discarded id resolved to
// no row, the [D-42] check missed, the merge ran a second time and its
// re-activation un-checked A's purchase.
func TestPush_Create_Merged_RetryReplaysWithoutReactivating(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	survivorID := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{
		OpID:       "seed",
		Collection: collectionItems,
		RecordID:   survivorID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("seed status = %v, want applied", r)
	}

	// B's duplicate-name create merges into it. (Its response is "lost" — the
	// test simply does not act on it, exactly as a dropped connection would.)
	deadID := randid.ID()
	mergeOp := []pushOp{{
		OpID:       "dup",
		Collection: collectionItems,
		RecordID:   deadID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk ", "quantity": "3"},
	}}
	if r := push(t, mux, tokB, mergeOp); len(r) != 1 || r[0].Status != "merged" {
		t.Fatalf("merge status = %v, want merged", r)
	}

	// A checks the survivor off in the meantime.
	if r := push(t, mux, tokA, []pushOp{{
		OpID:       "check",
		Collection: collectionItems,
		RecordID:   survivorID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"checked": true},
		Base:       map[string]any{"checked": false},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("check status = %v, want applied", r)
	}

	// B retries the identical create.
	replay := push(t, mux, tokB, mergeOp)
	if len(replay) != 1 || replay[0].Status != "merged" {
		t.Fatalf("replay status = %v, want merged", replay)
	}
	if replay[0].RecordID != survivorID {
		t.Errorf("replay record_id = %q, want the survivor %q", replay[0].RecordID, survivorID)
	}
	if replay[0].Record["checked"] != true {
		t.Errorf("replay checked = %v, want true — the retry must not re-activate",
			replay[0].Record["checked"])
	}

	rec, err := app.FindRecordById(collectionItems, survivorID)
	if err != nil {
		t.Fatalf("survivor lookup: %v", err)
	}
	if !rec.GetBool("checked") {
		t.Error("stored survivor was un-checked by the replay")
	}
	// And still exactly one row of that name — the replay must not insert either.
	items, err := app.FindAllRecords(collectionItems, dbx.HashExp{"list": listID})
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("list holds %d items, want 1", len(items))
	}
}

// TestPush_Create_Merged_KeepsIncomingChecked: an offline add-then-check
// coalesces `checked:true` into the create (§8.2 step 3). The caller's own
// action outranks [D-29] re-activation, which exists for someone ELSE's stale
// row: force-unchecking the survivor here would make the purchase vanish with
// no notice at all ([D-108]).
// A create that checks onto a survivor checked weeks ago is today's purchase:
// the old stamps would leave it out of the trip and file it under history.
func TestPush_Create_Merged_ChecksAnAlreadyCheckedSurvivorNow(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	survivorID := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{
		OpID: "seed", Collection: collectionItems, RecordID: survivorID, ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Milk", "checked": true},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("seed status = %v, want applied", r)
	}
	// Bought on an earlier trip.
	old := "2026-09-01 10:00:00.000Z"
	survivor, err := app.FindRecordById(collectionItems, survivorID)
	if err != nil {
		t.Fatal(err)
	}
	survivor.Set("checked_at", old)
	survivor.Set("last_bought_at", old)
	if err := app.Save(survivor); err != nil {
		t.Fatal(err)
	}

	results := push(t, mux, tokA, []pushOp{{
		OpID:       "dup",
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk", "checked": true},
	}})
	if len(results) != 1 || results[0].Status != "merged" {
		t.Fatalf("status = %v, want merged", results)
	}
	rec, err := app.FindRecordById(collectionItems, survivorID)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"checked_at", "last_bought_at"} {
		if got := rec.GetString(f); got <= old {
			t.Errorf("%s = %q, want a stamp after %s", f, got, old)
		}
	}
}

func TestPush_Create_Merged_KeepsIncomingChecked(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	survivorID := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{
		OpID:       "seed",
		Collection: collectionItems,
		RecordID:   survivorID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("seed status = %v, want applied", r)
	}

	results := push(t, mux, tokB, []pushOp{{
		OpID:       "dup",
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk ", "checked": true},
	}})
	if len(results) != 1 || results[0].Status != "merged" {
		t.Fatalf("status = %v, want merged", results)
	}
	if results[0].Record["checked"] != true {
		t.Errorf("checked = %v, want true — the caller's own check-off was dropped",
			results[0].Record["checked"])
	}
	// [D-79]: a checked row with no checked_at reads as LONG-SINCE checked and
	// skips the §9.1 recently-checked section, so the stamps must ride along.
	if results[0].Record["checked_at"] == nil {
		t.Error("checked_at is nil on a row the merge just checked")
	}
	if results[0].Record["last_bought_at"] == nil {
		t.Error("last_bought_at is nil on a row the merge just checked")
	}

	rec, err := app.FindRecordById(collectionItems, survivorID)
	if err != nil {
		t.Fatalf("survivor lookup: %v", err)
	}
	if !rec.GetBool("checked") {
		t.Error("stored survivor is not checked")
	}
}

// TestPush_Create_Merged_KeepsIncomingDeleted: the same rule for the other
// coalesced signal — added and removed again before either reached the server.
// Un-tombstoning here would put a row on the list that nobody asked to see.
func TestPush_Create_Merged_KeepsIncomingDeleted(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	survivorID := randid.ID()
	if r := push(t, mux, tokA, []pushOp{{
		OpID:       "seed",
		Collection: collectionItems,
		RecordID:   survivorID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("seed status = %v, want applied", r)
	}

	results := push(t, mux, tokB, []pushOp{{
		OpID:       "dup",
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "milk ", "deleted": true},
	}})
	if len(results) != 1 || results[0].Status != "merged" {
		t.Fatalf("status = %v, want merged", results)
	}
	rec, err := app.FindRecordById(collectionItems, survivorID)
	if err != nil {
		t.Fatalf("survivor lookup: %v", err)
	}
	if rec.GetString("deleted_at") == "" {
		t.Error("survivor is not tombstoned — the coalesced delete was dropped")
	}
}

// Two living same-name rows created in one millisecond: the merge picks the
// lower id, whichever was inserted first (§8.3).
func TestPush_Create_Merged_SameCreatedTieBreaksByID(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	high := seedItemRow(t, app, listID, "Milk", func(r *core.Record) { r.Id = "zzzzzzzzzzzzzzz" })
	low := seedItemRow(t, app, listID, "Milk", func(r *core.Record) { r.Id = "aaaaaaaaaaaaaaa" })
	if _, err := app.DB().NewQuery("UPDATE items SET created = {:at} WHERE list = {:list}").
		Bind(dbx.Params{"at": "2026-01-01 00:00:00.000Z", "list": listID}).Execute(); err != nil {
		t.Fatal(err)
	}

	res := push(t, mux, tok, []pushOp{{
		OpID: "add", Collection: collectionItems, RecordID: randid.ID(), ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}})
	if len(res) != 1 || res[0].Status != "merged" || res[0].RecordID != low.Id {
		t.Fatalf("result = %+v, want merged into %s, not %s", res, low.Id, high.Id)
	}
}
