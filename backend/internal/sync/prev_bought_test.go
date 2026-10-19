package sync

import (
	"testing"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// A tick keeps the purchase date it replaces; an untick that says "not bought"
// (the undo, putting a ticked item back) restores it, and a plain untick (a
// re-add: bought, needed again) keeps today's ([D-26]).
func TestPush_UntickNotBought_RestoresThePreviousPurchase(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	id := randid.ID()
	update := func(opID string, changed, base map[string]any) pushResult {
		t.Helper()
		r := push(t, mux, tok, []pushOp{{
			OpID: opID, Collection: collectionItems, RecordID: id, ListID: listID,
			Type: "update", Changed: changed, Base: base,
		}})
		if len(r) != 1 || r[0].Status != "applied" {
			t.Fatalf("%s: %v, want applied", opID, r)
		}
		return r[0]
	}
	if r := push(t, mux, tok, []pushOp{{
		OpID: "create", Collection: collectionItems, RecordID: id, ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}}); len(r) != 1 || r[0].Status != "applied" {
		t.Fatalf("create: %v", r)
	}
	bought := func() string {
		t.Helper()
		rec, err := app.FindRecordById(collectionItems, id)
		if err != nil {
			t.Fatal(err)
		}
		return rec.GetString("last_bought_at")
	}
	// Bought weeks ago.
	old := "2026-09-01 10:00:00.000Z"
	rec, _ := app.FindRecordById(collectionItems, id)
	rec.Set("last_bought_at", old)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}

	// Ticked by mistake, then taken back: the old purchase stands.
	update("tick", map[string]any{"checked": true}, map[string]any{"checked": false})
	if bought() == old {
		t.Fatal("a tick did not stamp a purchase")
	}
	r := update("undo", map[string]any{"checked": false, "bought": false}, map[string]any{"checked": true})
	if got := bought(); got != old {
		t.Fatalf("after the undo last_bought_at = %q, want %q", got, old)
	}
	if r.Record["last_bought_at"] != old {
		t.Fatalf("the result carries %v, want %q", r.Record["last_bought_at"], old)
	}

	// Ticked, then re-added (bought, needed again): today's purchase stands.
	update("tick2", map[string]any{"checked": true}, map[string]any{"checked": false})
	today := bought()
	update("readd", map[string]any{"checked": false}, map[string]any{"checked": true})
	if got := bought(); got != today {
		t.Fatalf("after a re-add last_bought_at = %q, want today's %q", got, today)
	}

	// A "not bought" untick of a row whose purchase is not its tick's own
	// (re-added, then a merge stamped another) leaves the date alone.
	update("tick3", map[string]any{"checked": true}, map[string]any{"checked": false})
	rec, _ = app.FindRecordById(collectionItems, id)
	rec.Set("last_bought_at", old)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	update("undo3", map[string]any{"checked": false, "bought": false}, map[string]any{"checked": true})
	if got := bought(); got != old {
		t.Fatalf("a purchase stamped since the tick was replaced: %q, want %q", got, old)
	}
}

// A never-bought item ticked by mistake and taken back is never bought: it
// must not land in "Frühere Artikel" once removed (§6.10).
func TestPush_UntickNotBought_LeavesANeverBoughtItemUnbought(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	id := randid.ID()
	for _, op := range []pushOp{
		{OpID: "create", Type: "create", Changed: map[string]any{"name": "Milk"}},
		{OpID: "tick", Type: "update", Changed: map[string]any{"checked": true}, Base: map[string]any{"checked": false}},
		{OpID: "undo", Type: "update", Changed: map[string]any{"checked": false, "bought": false}, Base: map[string]any{"checked": true}},
	} {
		op.Collection, op.RecordID, op.ListID = collectionItems, id, listID
		if r := push(t, mux, tok, []pushOp{op}); len(r) != 1 || r[0].Status != "applied" {
			t.Fatalf("%s: %v", op.OpID, r)
		}
	}
	rec, err := app.FindRecordById(collectionItems, id)
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.GetString("last_bought_at"); got != "" {
		t.Fatalf("last_bought_at = %q, want none", got)
	}
}

// The signal is a bool like `deleted`; anything else is refused as the wrong type.
func TestPush_BoughtSignalMustBeBool(t *testing.T) {
	if _, _, bad := fieldProblems(collectionItems, map[string]any{"checked": false, "bought": "no"}); bad != "bought" {
		t.Fatalf("badType = %q, want bought", bad)
	}
	if unknown, _, bad := fieldProblems(collectionItems, map[string]any{"checked": false, "bought": false}); unknown != "" || bad != "" {
		t.Fatalf("unknown %q, badType %q, want none", unknown, bad)
	}
}
