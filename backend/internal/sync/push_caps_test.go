package sync

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// The op-count cap and the field-length caps.

// TestPush_TooManyOps_Denied: pushing more than fieldcontract.MaxOpsPerPush() (500) ops in one
// request returns 400 BadRequest, preventing CPU/memory exhaustion.
func TestPush_TooManyOps_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	_, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, randid.ID(), "Test")

	// Build 501 create ops (one over the limit)
	ops := make([]pushOp, 0, 501)
	for i := range 501 {
		ops = append(ops, pushOp{
			OpID:       "op" + strconv.Itoa(i),
			Collection: collectionItems,
			RecordID:   randid.ID(),
			ListID:     listID,
			Type:       "create",
			Changed:    map[string]any{"name": "Item " + strconv.Itoa(i)},
		})
	}
	body, _ := json.Marshal(map[string]any{"ops": ops})
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/sync/push", string(body), testutil.AuthHeader(tok))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "too many ops") {
		t.Errorf("error message should mention 'too many ops', got: %s", rec.Body.String())
	}
}

// TestPush_OversizedField_Denied: a create op with a field exceeding its cap
// (name 257 bytes) is denied and the record is NOT created.
func TestPush_OversizedField_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	itemID := randid.ID()
	// 257 bytes: exceeds the 256-byte name cap
	oversizedName := strings.Repeat("a", 257)
	ops := []pushOp{{
		OpID:       "oversized",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": oversizedName},
	}}
	results := push(t, mux, tok, ops)
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}

	// Verify the record was NOT created
	if rec, _ := app.FindRecordById(collectionItems, itemID); rec != nil {
		t.Error("record should not have been created (oversized field)")
	}
}

// An op_id longer than the bound is a 400 for the batch: a merge stores it in
// merge_log, past the schema's own Max.
func TestPush_LongOpID_Rejected(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	ops := []pushOp{{
		OpID:       strings.Repeat("x", maxOpIDBytes+1),
		Collection: collectionItems,
		RecordID:   randid.ID(),
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	body, _ := json.Marshal(map[string]any{"ops": ops})
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/sync/push", string(body), testutil.AuthHeader(tok))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if n, _ := app.CountRecords(collectionItems, dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("%d items stored, want none", n)
	}
}
