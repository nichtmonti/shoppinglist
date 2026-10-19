package sync

import (
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// seedItemRow writes an items row directly, so a test can set up a server state
// the merge rules would never let a push produce — a tombstone beside a living
// twin of the same name, which is exactly what [D-176] has to cope with.
func seedItemRow(t *testing.T, app core.App, listID, name string, mods func(*core.Record)) *core.Record {
	t.Helper()
	col, _ := app.FindCollectionByNameOrId("items")
	rec := core.NewRecord(col)
	rec.Id = randid.ID()
	rec.Set("list", listID)
	rec.Set("name", name)
	rec.Set("checked", false)
	if mods != nil {
		mods(rec)
	}
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save item: %v", err)
	}
	return rec
}

func mustItem(t *testing.T, app core.App, id string) *core.Record {
	t.Helper()
	rec, err := app.FindRecordById("items", id)
	if err != nil {
		t.Fatalf("find item %s: %v", id, err)
	}
	return rec
}

var aWhileAgo = func() types.DateTime {
	dt, _ := types.ParseDateTime("2026-01-10 10:00:00.000Z")
	return dt
}()

// [D-175] A check-off coalesced into a late delete of an already-removed row is
// a purchase: it is stamped, while the removal still converges.
func TestPush_ConvergentDelete_KeepsCoalescedPurchase(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	row := seedItemRow(t, app, listID, "Brot", func(r *core.Record) { r.Set("deleted_at", aWhileAgo) })

	res := push(t, mux, tok, []pushOp{{
		OpID: "late", Collection: collectionItems, RecordID: row.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"checked": true, "deleted": true},
		Base:    map[string]any{"checked": false},
	}})

	if len(res) != 1 || res[0].Status != "applied" {
		t.Fatalf("result = %+v, want applied", res)
	}
	got := mustItem(t, app, row.Id)
	if got.GetDateTime("last_bought_at").IsZero() {
		t.Error("the purchase was dropped: last_bought_at is still empty")
	}
	if got.GetDateTime("deleted_at").String() != aWhileAgo.String() {
		t.Errorf("deleted_at = %v, want the original removal kept", got.GetDateTime("deleted_at"))
	}
	if res[0].Record["last_bought_at"] == "" {
		t.Error("the answer's record does not carry the stamp")
	}
}

// Without a check-off the convergent delete stays a silent no-op.
func TestPush_ConvergentDelete_WithoutCheckStaysNoop(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	row := seedItemRow(t, app, listID, "Brot", func(r *core.Record) { r.Set("deleted_at", aWhileAgo) })

	res := push(t, mux, tok, []pushOp{{
		OpID: "late", Collection: collectionItems, RecordID: row.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": true, "quantity": "3"}, Base: map[string]any{"quantity": ""},
	}})
	if len(res) != 1 || res[0].Status != "noop" {
		t.Fatalf("result = %+v, want noop", res)
	}
	if !mustItem(t, app, row.Id).GetDateTime("last_bought_at").IsZero() {
		t.Error("a delete without a check-off must not invent a purchase")
	}
}

// [D-176] Restoring a tombstone while a living row of the same name is on the
// list merges into that row: one row, its values kept, re-activated, carrying
// the newer purchase memory; the tombstone stops counting as history.
func TestPush_Restore_MergesIntoLivingTwin(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) {
		r.Set("deleted_at", aWhileAgo)
		r.Set("last_bought_at", aWhileAgo)
		r.Set("quantity", "1")
	})
	twin := seedItemRow(t, app, listID, "brot ", func(r *core.Record) {
		r.Set("quantity", "2")
		r.Set("checked", true)
		r.Set("checked_at", types.NowDateTime())
	})

	res := push(t, mux, tok, []pushOp{{
		OpID: "back", Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false, "quantity": "3"}, Base: map[string]any{"quantity": "1"},
	}})

	if len(res) != 1 || res[0].Status != "merged" || res[0].RecordID != twin.Id {
		t.Fatalf("result = %+v, want merged into %s", res, twin.Id)
	}
	if len(res[0].Conflicts) != 1 || res[0].Conflicts[0].Field != "quantity" {
		t.Errorf("conflicts = %+v, want the discarded quantity reported", res[0].Conflicts)
	}
	gotTwin := mustItem(t, app, twin.Id)
	if gotTwin.GetBool("checked") || gotTwin.GetString("quantity") != "2" {
		t.Errorf("survivor = checked:%v quantity:%q, want re-activated with its own quantity",
			gotTwin.GetBool("checked"), gotTwin.GetString("quantity"))
	}
	gotTomb := mustItem(t, app, tomb.Id)
	if gotTomb.GetDateTime("deleted_at").IsZero() {
		t.Error("the tombstone was lifted beside its twin: two living rows")
	}
	if !gotTomb.GetDateTime("last_bought_at").IsZero() {
		t.Error("the tombstone still counts as history beside the living row")
	}
}

// [D-176] A tombstone written outside the app before the save hook stamped
// name_norm has an empty one; restored beside a living twin it still merges,
// and never into another such row, because the merge normalises the name
// itself rather than trusting the stored column.
func TestPush_Restore_TombstoneWithoutNameNormStillMerges(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) {
		r.Set("deleted_at", aWhileAgo)
		r.Set("last_bought_at", aWhileAgo)
	})
	other := seedItemRow(t, app, listID, "Milch", nil)
	twin := seedItemRow(t, app, listID, " BROT", nil)
	for _, id := range []string{tomb.Id, other.Id} {
		if _, err := app.DB().NewQuery("UPDATE items SET name_norm = '' WHERE id = {:id}").
			Bind(dbx.Params{"id": id}).Execute(); err != nil {
			t.Fatal(err)
		}
	}

	res := push(t, mux, tok, []pushOp{{
		OpID: "back", Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false},
	}})

	if len(res) != 1 || res[0].Status != "merged" || res[0].RecordID != twin.Id {
		t.Fatalf("result = %+v, want merged into %s", res, twin.Id)
	}
	if mustItem(t, app, tomb.Id).GetDateTime("deleted_at").IsZero() {
		t.Error("the tombstone was lifted beside its twin: two living rows")
	}
}

// A blank on the living twin takes the restore's value with no conflict
// ([D-29]), as a duplicate create's does; its own value still wins above.
func TestPush_Restore_BlankTwinTakesTheValue(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) {
		r.Set("deleted_at", aWhileAgo)
		r.Set("last_bought_at", aWhileAgo)
		r.Set("quantity", "1")
	})
	twin := seedItemRow(t, app, listID, "Brot", nil)

	res := push(t, mux, tok, []pushOp{{
		OpID: "back", Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false, "quantity": "3"}, Base: map[string]any{"quantity": "1"},
	}})
	if len(res) != 1 || res[0].Status != "merged" || len(res[0].Conflicts) != 0 {
		t.Fatalf("result = %+v, want merged with no conflict", res)
	}
	if got := mustItem(t, app, twin.Id).GetString("quantity"); got != "3" {
		t.Errorf("survivor quantity = %q, want the restore's 3", got)
	}
}

// The purchase memory moves to the survivor when the tombstone's is newer.
func TestPush_Restore_MovesNewerPurchaseMemory(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) {
		r.Set("deleted_at", aWhileAgo)
		r.Set("last_bought_at", aWhileAgo)
	})
	twin := seedItemRow(t, app, listID, "Brot", nil) // never bought

	push(t, mux, tok, []pushOp{{
		OpID: "back", Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false},
	}})
	if got := mustItem(t, app, twin.Id).GetDateTime("last_bought_at"); got.String() != aWhileAgo.String() {
		t.Errorf("survivor last_bought_at = %v, want the tombstone's %v", got, aWhileAgo)
	}
}

// A retried restore (the first answer was lost) replays the merge instead of
// running it again — so it cannot re-activate a row someone checked since.
func TestPush_Restore_RetryReplaysWithoutSideEffects(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) { r.Set("deleted_at", aWhileAgo) })
	twin := seedItemRow(t, app, listID, "Brot", nil)
	op := pushOp{
		OpID: "back", Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false},
	}
	push(t, mux, tok, []pushOp{op})

	// Someone checks the survivor off in between.
	rec := mustItem(t, app, twin.Id)
	rec.Set("checked", true)
	rec.Set("checked_at", types.NowDateTime())
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}

	// The retry of a lost answer: the same op, re-sent.
	res := push(t, mux, tok, []pushOp{op})
	if len(res) != 1 || res[0].Status != "merged" || res[0].RecordID != twin.Id {
		t.Fatalf("retry = %+v, want the merge replayed", res)
	}
	if !mustItem(t, app, twin.Id).GetBool("checked") {
		t.Error("the retry re-ran the merge and un-checked a purchase made since")
	}
}

// A later restore of the same tombstone is a new op, not a retry: a phone
// offline since the first one restores it again, and the log must not answer
// with the old merge ([D-176]). With the survivor removed since, the tombstone
// itself comes back.
func TestPush_Restore_LaterRestoreIsNoReplay(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) {
		r.Set("deleted_at", aWhileAgo)
		r.Set("last_bought_at", aWhileAgo)
	})
	twin := seedItemRow(t, app, listID, "Brot", nil)
	restore := func(opID string) []pushResult {
		return push(t, mux, tok, []pushOp{{
			OpID: opID, Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
			Changed: map[string]any{"deleted": false},
		}})
	}
	if res := restore("monday"); len(res) != 1 || res[0].Status != "merged" {
		t.Fatalf("first restore = %+v, want merged", res)
	}

	// The survivor is removed on Tuesday.
	rec := mustItem(t, app, twin.Id)
	rec.Set("deleted_at", types.NowDateTime())
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}

	res := restore("wednesday")
	if len(res) != 1 || res[0].Status != "applied" {
		t.Fatalf("later restore = %+v, want the tombstone lifted", res)
	}
	if !mustItem(t, app, tomb.Id).GetDateTime("deleted_at").IsZero() {
		t.Error("the later restore did nothing: the tombstone is still removed")
	}
}

// With no living twin a restore lifts the tombstone, as before.
func TestPush_Restore_WithoutTwinLiftsTombstone(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	tomb := seedItemRow(t, app, listID, "Brot", func(r *core.Record) {
		r.Set("deleted_at", aWhileAgo)
		r.Set("last_bought_at", aWhileAgo)
	})
	_ = seedItemRow(t, app, listID, "Milch", nil)

	res := push(t, mux, tok, []pushOp{{
		OpID: "back", Collection: collectionItems, RecordID: tomb.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false},
	}})
	if len(res) != 1 || res[0].Status != "applied" {
		t.Fatalf("result = %+v, want applied", res)
	}
	if !mustItem(t, app, tomb.Id).GetDateTime("deleted_at").IsZero() {
		t.Error("the tombstone was not lifted")
	}
}
