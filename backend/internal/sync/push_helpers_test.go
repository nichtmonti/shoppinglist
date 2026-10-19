package sync

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/barcode"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// setupSyncApp bootstraps a temp app with migrations + the category_templates
// seed applied + the §8 sync routes and record hooks, returning the app and a
// dispatchable mux.
func setupSyncApp(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	return setupSyncAppWith(t, listcap.Default())
}

// setupSyncAppWith is setupSyncApp under the given caps.
func setupSyncAppWith(t *testing.T, caps listcap.Caps) (*pocketbase.PocketBase, http.Handler) {
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) { RegisterRoutes(r, caps) })
	Register(app)
	barcode.Register(app) // the [D-266] photo the push tests read
	return app, mux
}

// seedOtherCategory creates a list_categories row with slug "other" for the list
// (used by the Others-protection test).
func seedOtherCategory(t *testing.T, app core.App, listID string) string {
	t.Helper()
	col, _ := app.FindCollectionByNameOrId("list_categories")
	rec := core.NewRecord(col)
	rec.Id = randid.ID()
	rec.Set("list", listID)
	rec.Set("slug", "other")
	rec.Set("icon", "folder")
	rec.Set("color", "gray")
	rec.Set("sort_order", 99)
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save category: %v", err)
	}
	return rec.Id
}

// addMembership adds a second membership for acctB on the list.
func addMembership(t *testing.T, app core.App, acctB, listID string) {
	t.Helper()
	memCol, _ := app.FindCollectionByNameOrId("memberships")
	mem := core.NewRecord(memCol)
	mem.Id = randid.ID()
	mem.Set("account", acctB)
	mem.Set("list", listID)
	if err := app.SaveNoValidate(mem); err != nil {
		t.Fatalf("save membership: %v", err)
	}
}

// push sends an ops batch and returns the results array.
func push(t *testing.T, mux http.Handler, token string, ops []pushOp) []pushResult {
	body, _ := json.Marshal(map[string]any{"ops": ops})
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/sync/push", string(body), testutil.AuthHeader(token))
	if rec.Code != http.StatusOK {
		t.Fatalf("push status %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Results []pushResult `json:"results"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	return resp.Results
}
