package sync

import (
	"errors"
	"sort"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// failingCountApp is a core.App whose CountRecords always fails: the membership
// check cannot run.
type failingCountApp struct {
	core.App
}

func (f *failingCountApp) CountRecords(collectionModelOrIdentifier any, exprs ...dbx.Expression) (int64, error) {
	return 0, errors.New("injected count failure")
}

// A membership lookup that FAILS is not a verdict: the op must stay queued
// (an error, which omits its result), not collect a terminal not_member whose toast the client
// suppresses — that would drop the edit silently.
func TestProcessOp_MembershipLookupFailure_Retries(t *testing.T) {
	app, _ := setupSyncApp(t)
	stub := &failingCountApp{App: app}
	op := pushOp{
		OpID: "m", Collection: collectionItems, RecordID: randid.ID(), ListID: "listA",
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}
	if r, err := processOp(stub, op, "caller1", newMembershipCache(stub, "caller1"), listcap.Default().Items); err == nil {
		t.Errorf("status = %q (reason %q), want an error", r.Status, r.Reason)
	}
}

// countingApp counts membership lookups.
type countingApp struct {
	core.App
	counts int
}

func (c *countingApp) CountRecords(collectionModelOrIdentifier any, exprs ...dbx.Expression) (int64, error) {
	if collectionModelOrIdentifier == "memberships" {
		c.counts++
	}
	return c.App.CountRecords(collectionModelOrIdentifier, exprs...)
}

// One push asks for the caller's membership once per list, not once per op.
func TestMembershipCache_OneLookupPerList(t *testing.T) {
	app, _ := setupSyncApp(t)
	acct, _ := testutil.CreateAccount(t, app, "Alice")
	listA := testutil.CreateListFor(t, app, acct, "Test")
	listB := testutil.CreateListFor(t, app, randid.ID(), "Test")
	stub := &countingApp{App: app}
	cache := newMembershipCache(stub, acct)
	for range 5 {
		if ok, err := cache.isMember(listA); err != nil || !ok {
			t.Fatalf("isMember(listA) = %v, %v; want true", ok, err)
		}
		if ok, err := cache.isMember(listB); err != nil || ok {
			t.Fatalf("isMember(listB) = %v, %v; want false", ok, err)
		}
	}
	if stub.counts != 2 {
		t.Errorf("membership lookups = %d, want 2 (one per list)", stub.counts)
	}
}

// The client's merged toast reads conflicts in order, so the order must not
// depend on Go's map iteration: conflicts come back sorted by field.
func TestPush_ConflictsAreInFieldOrder(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	row := seedItemRow(t, app, listID, "Milk", func(r *core.Record) {
		r.Set("quantity", "2")
		r.Set("note", "fresh")
		r.Set("barcode", "4000000000001")
		r.Set("category_key", "dairy")
	})
	changed := map[string]any{"quantity": "5", "note": "any", "barcode": "4000000000002", "category_key": "other"}

	for range 20 {
		// Update without base coverage: every field conflicts.
		upd := push(t, mux, tok, []pushOp{{
			OpID: "u", Collection: collectionItems, RecordID: row.Id, ListID: listID, Type: "update",
			Changed: changed,
		}})
		assertFieldOrder(t, "update", upd)

		// Duplicate-name create: merges, every differing field conflicts.
		merged := push(t, mux, tok, []pushOp{{
			OpID: "c", Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Milk", "quantity": "5", "note": "any", "barcode": "4000000000002", "category_key": "other"},
		}})
		assertFieldOrder(t, "merge", merged)
	}
}

func assertFieldOrder(t *testing.T, what string, res []pushResult) {
	t.Helper()
	if len(res) != 1 || len(res[0].Conflicts) != 4 {
		t.Fatalf("%s: result = %+v, want one result with 4 conflicts", what, res)
	}
	fields := make([]string, 0, 4)
	for _, c := range res[0].Conflicts {
		fields = append(fields, c.Field)
	}
	if !sort.StringsAreSorted(fields) {
		t.Fatalf("%s: conflict order = %v, want sorted", what, fields)
	}
}

// lookupFailApp fails the lookup of one items row and delegates the rest to a
// real app, inside the transaction too.
type lookupFailApp struct {
	core.App
	failID string
}

func (f *lookupFailApp) RunInTransaction(fn func(core.App) error) error {
	return f.App.RunInTransaction(func(tx core.App) error {
		return fn(&lookupFailApp{App: tx, failID: f.failID})
	})
}

func (f *lookupFailApp) FindRecordById(collectionModelOrIdentifier any, recordId string, optFilters ...func(q *dbx.SelectQuery) error) (*core.Record, error) {
	if collectionModelOrIdentifier == collectionItems && recordId == f.failID {
		return nil, errors.New("injected lookup failure")
	}
	return f.App.FindRecordById(collectionModelOrIdentifier, recordId, optFilters...)
}

// A re-delivered create whose duplicate-id lookup FAILS must retry. Swallowing
// the error let it fall through to the name merge, which then merged the row
// into itself and logged it as its own survivor.
func TestPush_Create_DuplicateLookupFailure_Retries(t *testing.T) {
	app, _ := setupSyncApp(t)
	acct, _ := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	row := seedItemRow(t, app, listID, "Milk", nil)

	r, err := processCreate(&lookupFailApp{App: app, failID: row.Id}, pushOp{
		OpID: "again", Collection: collectionItems, RecordID: row.Id, ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}, acct, listcap.Default().Items)
	if err == nil {
		t.Errorf("status = %q, want an error", r.Status)
	}
	if logged, _ := app.FindRecordById("merge_log", row.Id); logged != nil {
		t.Error("the row was merged into itself (merge_log names it its own survivor)")
	}
}

// A create whose id already names a row on ANOTHER list can never succeed:
// it is a terminal denial, not a server failure retried forever.
func TestPush_Create_IdTakenOnOtherList_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Alice")
	listA := testutil.CreateListFor(t, app, acct, "Test")
	listB := testutil.CreateListFor(t, app, acct, "Test")
	row := seedItemRow(t, app, listB, "Milk", nil)

	res := push(t, mux, tok, []pushOp{{
		OpID: "collide", Collection: collectionItems, RecordID: row.Id, ListID: listA,
		Type: "create", Changed: map[string]any{"name": "Bread"},
	}})
	if len(res) != 1 || res[0].Status != "denied" || res[0].Reason != reasonBadRecordID {
		t.Fatalf("result = %+v, want denied/bad_record_id", res)
	}
	if res[0].Record != nil {
		t.Error("a denial must not carry the other list's row")
	}
}

// saveMergeLog stores a merge_log row (discarded id → survivor) for a list.
func saveMergeLog(t *testing.T, app core.App, id, listID, survivor string) {
	t.Helper()
	col, _ := app.FindCollectionByNameOrId("merge_log")
	rec := core.NewRecord(col)
	rec.Id = id
	rec.Set("list", listID)
	rec.Set("survivor", survivor)
	rec.Set("merged_at", now())
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
}

// A merge_log row whose survivor is gone can no longer answer a replay, and
// must not block the merge it would otherwise collide with (merge_log is
// keyed by the create's id).
func TestPush_Create_StaleMergeLog_DoesNotBlockMerge(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	twin := seedItemRow(t, app, listID, "Milk", nil)
	opID := randid.ID()
	saveMergeLog(t, app, opID, listID, randid.ID())

	res := push(t, mux, tok, []pushOp{{
		OpID: "c", Collection: collectionItems, RecordID: opID, ListID: listID,
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}})
	if len(res) != 1 || res[0].Status != "merged" || res[0].RecordID != twin.Id {
		t.Fatalf("result = %+v, want merged into %s", res, twin.Id)
	}
	logged, err := app.FindRecordById("merge_log", opID)
	if err != nil {
		t.Fatalf("merge_log lookup: %v", err)
	}
	if logged.GetString("list") != listID || logged.GetString("survivor") != twin.Id {
		t.Errorf("merge_log = (%s → %s), want (%s → %s)",
			logged.GetString("list"), logged.GetString("survivor"), listID, twin.Id)
	}
}

// A create on your own list under an id ANOTHER list logged is denied like an
// id another list's row holds, and that list's merge_log row stays: deleting
// it would turn the other list's queued retry into a revert.
func TestPush_Create_OtherListsMergeLog_DeniedAndKept(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	bob, _ := testutil.CreateAccount(t, app, "Bob")
	own := testutil.CreateListFor(t, app, alice, "Own")
	other := testutil.CreateListFor(t, app, bob, "Other")
	survivor := seedItemRow(t, app, other, "Milk", nil)
	seedItemRow(t, app, own, "Milk", nil)
	opID := randid.ID()
	saveMergeLog(t, app, opID, other, survivor.Id)

	res := push(t, mux, tok, []pushOp{{
		OpID: "c", Collection: collectionItems, RecordID: opID, ListID: own,
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}})
	if len(res) != 1 || res[0].Status != "denied" || res[0].Reason != reasonBadRecordID {
		t.Fatalf("result = %+v, want denied/bad_record_id", res)
	}
	logged, err := app.FindRecordById("merge_log", opID)
	if err != nil {
		t.Fatalf("the other list's merge_log row is gone: %v", err)
	}
	if logged.GetString("list") != other || logged.GetString("survivor") != survivor.Id {
		t.Errorf("merge_log = (%s → %s), want (%s → %s)",
			logged.GetString("list"), logged.GetString("survivor"), other, survivor.Id)
	}
}

// A restore signal on a row that is not removed changes nothing: no save, no
// `updated` bump (which would fan a no-change out to every member), noop.
func TestPush_Update_RestoreOfLivingRow_Noop(t *testing.T) {
	app, mux := setupSyncApp(t)
	acct, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acct, "Test")
	row := seedItemRow(t, app, listID, "Milk", nil)
	before := mustItem(t, app, row.Id).GetString("updated")

	res := push(t, mux, tok, []pushOp{{
		OpID: "r", Collection: collectionItems, RecordID: row.Id, ListID: listID, Type: "update",
		Changed: map[string]any{"deleted": false},
	}})
	if len(res) != 1 || res[0].Status != "noop" {
		t.Fatalf("result = %+v, want noop", res)
	}
	if after := mustItem(t, app, row.Id).GetString("updated"); after != before {
		t.Errorf("updated moved %s → %s on a no-change restore", before, after)
	}
}
