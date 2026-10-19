package lists

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// TestAddMissingCategories ([D-251]): a list made before the seed grew
// aisles takes them, with their slugs, after every row it has; an aisle a
// member removed stays removed, a retired one is not offered ([D-300]); a
// second call adds nothing.
func TestAddMissingCategories(t *testing.T) {
	app, mux := setupListsApp(t)
	_, tok := testutil.CreateAccount(t, app, "Anna")
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists", `{"name":"Alt"}`,
		testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rec.Code, body)
	}
	var list struct{ ID string }
	if err := json.Unmarshal([]byte(body), &list); err != nil || list.ID == "" {
		t.Fatalf("create body: %s", body)
	}

	// The list as an older seed made it: without coffee and the errand aisles,
	// and with Baby removed by a member. It never had the retired Garden.
	for _, slug := range []string{"coffee_tea", "pharmacy", "hardware", "car_bike"} {
		row, err := app.FindFirstRecordByFilter("list_categories",
			"list = {:list} && slug = {:slug}", dbx.Params{"list": list.ID, "slug": slug})
		if err != nil {
			t.Fatalf("find %s: %v", slug, err)
		}
		if err := app.Delete(row); err != nil {
			t.Fatalf("delete %s: %v", slug, err)
		}
	}
	baby, err := app.FindFirstRecordByFilter("list_categories",
		"list = {:list} && slug = 'baby'", dbx.Params{"list": list.ID})
	if err != nil {
		t.Fatalf("find baby: %v", err)
	}
	baby.Set("deleted_at", types.NowDateTime())
	if err := app.SaveNoValidate(baby); err != nil {
		t.Fatalf("remove baby: %v", err)
	}
	maxBefore := maxSortOrder(t, app, list.ID)

	call := func() []string {
		t.Helper()
		rec, body := testutil.DoReq(mux, http.MethodPost,
			"/api/lists/"+list.ID+"/categories/missing", `{}`, testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Fatalf("missing = %d: %s", rec.Code, body)
		}
		var out struct{ Added []string }
		if err := json.Unmarshal([]byte(body), &out); err != nil {
			t.Fatalf("missing body: %s", body)
		}
		return out.Added
	}

	added := call()
	want := []string{"coffee_tea", "pharmacy", "hardware", "car_bike"}
	if len(added) != len(want) {
		t.Fatalf("added = %v, want %v (template order; baby stays removed)", added, want)
	}
	for i := range want {
		if added[i] != want[i] {
			t.Fatalf("added = %v, want %v", added, want)
		}
	}
	for i, slug := range want {
		row, err := app.FindFirstRecordByFilter("list_categories",
			"list = {:list} && slug = {:slug} && deleted_at = ''",
			dbx.Params{"list": list.ID, "slug": slug})
		if err != nil {
			t.Fatalf("%s not added: %v", slug, err)
		}
		if got := row.GetInt("sort_order"); got != maxBefore+1+i {
			t.Errorf("%s sort_order = %d, want %d (after every existing row)", slug, got, maxBefore+1+i)
		}
		if row.GetString("name") != "" {
			t.Errorf("%s name = %q, want empty (the localized default)", slug, row.GetString("name"))
		}
		tpl, _ := app.FindFirstRecordByFilter("category_templates", "slug = {:slug}",
			dbx.Params{"slug": slug})
		if row.GetString("icon") != tpl.GetString("icon") || row.GetString("color") != tpl.GetString("color") {
			t.Errorf("%s icon/color = %q/%q, want the template's", slug, row.GetString("icon"), row.GetString("color"))
		}
	}

	if again := call(); len(again) != 0 {
		t.Errorf("second call added %v, want nothing", again)
	}
}

func TestAddMissingCategoriesNeedsMembership(t *testing.T) {
	app, mux := setupListsApp(t)
	_, tok := testutil.CreateAccount(t, app, "Mallory")
	listID := testutil.CreateList(t, app, "")

	rec, _ := testutil.DoReq(mux, http.MethodPost,
		"/api/lists/"+listID+"/categories/missing", `{}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusNotFound {
		t.Errorf("non-member = %d, want 403 or 404", rec.Code)
	}
	n, err := app.CountRecords("list_categories", dbx.HashExp{"list": listID})
	if err != nil || n != 0 {
		t.Errorf("non-member call wrote %d rows (err %v)", n, err)
	}
}

// TestAddMissingCategoriesAfterLeaving (§7.3): the last member leaves on
// another device between the gate and the transaction, and the cascade
// deletes the list. The route refuses and writes no row for it.
func TestAddMissingCategoriesAfterLeaving(t *testing.T) {
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		security.MemberRoutes(r).POST("/api/lists/{listId}/categories/missing", addMissingCategories).
			BindFunc(testutil.LeaveAfterGate)
	})
	Register(app)
	acctID, tok := testutil.CreateAccount(t, app, "Anna")
	listID := testutil.CreateListFor(t, app, acctID, "")

	rec, body := testutil.DoReq(mux, http.MethodPost,
		"/api/lists/"+listID+"/categories/missing", `{}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing after leaving = %d, want 403: %s", rec.Code, body)
	}
	if n, err := app.CountRecords("list_categories", dbx.HashExp{"list": listID}); err != nil || n != 0 {
		t.Errorf("wrote %d rows for the deleted list (err %v)", n, err)
	}
}

func maxSortOrder(t *testing.T, app core.App, listID string) int {
	t.Helper()
	rows, err := app.FindRecordsByFilter("list_categories", "list = {:list}", "", 0, 0,
		dbx.Params{"list": listID})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	m := 0
	for _, r := range rows {
		if o := r.GetInt("sort_order"); o > m {
			m = o
		}
	}
	return m
}
