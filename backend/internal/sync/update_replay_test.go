package sync

import (
	"testing"

	"shoppinglist/internal/testutil"
)

// A re-delivered update is answered from its first delivery ([D-42]): when a
// co-member set the field back to the op's base in between, the retry must
// not apply again over that later edit. The `deleted` signal has no base at
// all, so a retried removal would otherwise undo any restore since.
func TestPush_Update_RedeliveryDoesNotUndoALaterEdit(t *testing.T) {
	app, mux := setupSyncApp(t)
	anna, annaTok := testutil.CreateAccount(t, app, "Anna")
	ben, benTok := testutil.CreateAccount(t, app, "Ben")
	listID := testutil.CreateListFor(t, app, anna, "Test")
	addMembership(t, app, ben, listID)
	row := seedItemRow(t, app, listID, "Milk", nil)
	update := func(opID string, changed, base map[string]any) pushOp {
		return pushOp{OpID: opID, Collection: collectionItems, RecordID: row.Id, ListID: listID,
			Type: "update", Changed: changed, Base: base}
	}

	tick := update("a1", map[string]any{"checked": true}, map[string]any{"checked": false})
	remove := update("a2", map[string]any{"deleted": true}, nil)
	for _, op := range []pushOp{tick, remove} {
		if res := push(t, mux, annaTok, []pushOp{op}); res[0].Status != statusApplied {
			t.Fatalf("first delivery of %s = %+v, want applied", op.OpID, res)
		}
	}
	push(t, mux, benTok, []pushOp{
		update("b1", map[string]any{"deleted": false}, nil),
		update("b2", map[string]any{"checked": false}, map[string]any{"checked": true}),
	})

	// Anna's answers were lost; her device sends both again, unchanged.
	again := push(t, mux, annaTok, []pushOp{tick, remove})
	if len(again) != 2 {
		t.Fatalf("re-delivery answered %d of 2 ops: %+v", len(again), again)
	}
	for _, res := range again {
		// Nothing applies again; Ben's untick is what Anna's tick now meets.
		if res.Status != statusNoop && res.Status != statusPartial {
			t.Errorf("re-delivery of %s = %s, want it answered from its first delivery", res.OpID, res.Status)
		}
	}
	got := mustItem(t, app, row.Id)
	if got.GetBool("checked") || got.GetString("deleted_at") != "" {
		t.Errorf("checked=%v deleted_at=%q: a retry undid Ben's later edits", got.GetBool("checked"), got.GetString("deleted_at"))
	}

	// Edits made while an op was in flight go out under the same op id with
	// other fields: a new delivery, decided afresh.
	retick := update("a1", map[string]any{"checked": true}, map[string]any{"checked": false})
	retick.Changed["quantity"] = "2"
	retick.Base["quantity"] = ""
	if res := push(t, mux, annaTok, []pushOp{retick}); res[0].Status != statusApplied {
		t.Errorf("new payload under a known op id = %+v, want applied", res)
	}
}
