package lists

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/barcode"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/sync"
	"shoppinglist/internal/testutil"
)

// setupListsApp bootstraps a temp app with migrations + the category_templates
// seed applied + the §7.4/§7.5 list routes mounted, returning the app and a
// dispatchable mux. The sync hooks stamp each item's derived columns, as
// serve wires them.
func setupListsApp(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	return setupListsAppWith(t, listcap.Default())
}

// setupListsAppWith is setupListsApp under the given caps.
func setupListsAppWith(t *testing.T, caps listcap.Caps) (*pocketbase.PocketBase, http.Handler) {
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) { RegisterRoutes(r, caps) })
	sync.Register(app)
	barcode.Register(app)
	return app, mux
}

// TestCreateListHappyPath (§7.5): an authenticated create produces the lists
// row (with the client-supplied id), exactly one membership row for the
// creator, and a full per-list copy of the 21 category_templates seed rows —
// each with a non-empty slug/icon/color and an EMPTY name (null -> render the
// localized template default).
func TestCreateListHappyPath(t *testing.T) {
	app, mux := setupListsApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")

	body := `{"name":"Alice's List"}`
	rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists", body, testutil.AuthHeader(tok))
	listID := listIDOf(t, respBody)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, want 200: %s", rec.Code, respBody)
	}
	if !strings.Contains(respBody, listID) {
		t.Errorf("response body missing list id %q: %s", listID, respBody)
	}

	listRec, err := app.FindRecordById("lists", listID)
	if err != nil || listRec == nil {
		t.Fatalf("lists row not found for id %q: %v", listID, err)
	}

	memberships, err := app.FindAllRecords("memberships", dbx.HashExp{"account": acctID, "list": listID})
	if err != nil {
		t.Fatalf("find memberships: %v", err)
	}
	if len(memberships) != 1 {
		t.Fatalf("memberships count = %d, want 1", len(memberships))
	}
	// The name is the list's ([D-08]), not the creator's membership's.
	if got := listRec.GetString("name"); got != "Alice's List" {
		t.Errorf("lists.name = %q, want %q", got, "Alice's List")
	}

	templates, err := app.FindRecordsByFilter("category_templates", "", "+sort_order", 0, 0)
	if err != nil {
		t.Fatalf("find category_templates: %v", err)
	}
	// Derived from the seed JSON (same rationale as seed_test.go): the copy-on-
	// create count tracks whatever the seeder ships, and a seed append must not
	// require touching this file.
	var seedCategories []map[string]any
	// CWD for Go tests is the package dir; the seed JSONs are two levels up.
	seedJSON, err := os.ReadFile("../../seed/categories.json")
	if err != nil {
		t.Fatalf("read seed categories.json: %v", err)
	}
	if err := json.Unmarshal(seedJSON, &seedCategories); err != nil {
		t.Fatalf("unmarshal seed categories.json: %v", err)
	}
	if len(templates) != len(seedCategories) {
		t.Fatalf("category_templates count = %d, want %d (from seed/categories.json)", len(templates), len(seedCategories))
	}

	cats, err := app.FindAllRecords("list_categories", dbx.HashExp{"list": listID})
	if err != nil {
		t.Fatalf("find list_categories: %v", err)
	}
	current := 0
	for _, c := range seedCategories {
		if c["retired"] != true {
			current++
		}
	}
	if len(cats) != current {
		t.Fatalf("list_categories count = %d, want %d (the per-list copy, retired aisles left out)", len(cats), current)
	}

	byOrder := make(map[int]*core.Record, len(cats))
	for _, c := range cats {
		if c.GetString("slug") == "" {
			t.Errorf("list_category %s has empty slug", c.Id)
		}
		if c.GetString("icon") == "" {
			t.Errorf("list_category %s has empty icon", c.Id)
		}
		if c.GetString("color") == "" {
			t.Errorf("list_category %s has empty color", c.Id)
		}
		if got := c.GetString("name"); got != "" {
			t.Errorf("list_category %s name = %q, want empty (null)", c.Id, got)
		}
		byOrder[c.GetInt("sort_order")] = c
	}
	for _, tpl := range templates {
		c, ok := byOrder[tpl.GetInt("sort_order")]
		if tpl.GetBool("retired") {
			if ok {
				t.Errorf("retired template %q was copied ([D-300])", tpl.GetString("slug"))
			}
			continue
		}
		if !ok {
			t.Errorf("no list_category with sort_order %d matching template %q", tpl.GetInt("sort_order"), tpl.GetString("slug"))
			continue
		}
		if c.GetString("slug") != tpl.GetString("slug") {
			t.Errorf("sort_order %d: slug = %q, want %q", tpl.GetInt("sort_order"), c.GetString("slug"), tpl.GetString("slug"))
		}
	}
}

// TestCreateListUnauthenticated: no Authorization header -> 401, zero lists created.
func TestCreateListUnauthenticated(t *testing.T) {
	app, mux := setupListsApp(t)
	body := `{"name":"Nope"}`
	rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists", body, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", rec.Code, respBody)
	}
	if n, _ := app.CountRecords("lists"); n != 0 {
		t.Errorf("lists count after unauthenticated create = %d, want 0", n)
	}
}

// TestCreateListMissingFields (§7.5): a missing or blank name is a 400 — a
// list every member sees has to be called something ([D-08]). There is
// deliberately no "missing id" case: the server mints the id ([D-08]) and an
// `id` in the body is ignored, so its absence is the normal shape.
func TestCreateListMissingFields(t *testing.T) {
	app, mux := setupListsApp(t)
	_, tok := testutil.CreateAccount(t, app, "Bob")

	for _, body := range []string{`{}`, `{"name":""}`, `{"name":"   "}`, `{"display_name":"Old field"}`} {
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists", body, testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d, want 400: %s", body, rec.Code, respBody)
		}
	}
	if n, _ := app.CountRecords("lists"); n != 0 {
		t.Errorf("lists = %d after refused creates, want 0", n)
	}
}

// TestCreateListNameCap: the route writes with SaveNoValidate, so the shared
// contract's lists.name cap is the only bound ([D-08]).
func TestCreateListNameCap(t *testing.T) {
	app, mux := setupListsApp(t)
	_, tok := testutil.CreateAccount(t, app, "Bob")
	max, ok := fieldcontract.MaxBytes("lists", "name")
	if !ok {
		t.Fatal("contract has no lists.name cap")
	}

	over, _ := json.Marshal(map[string]string{"name": strings.Repeat("x", max+1)})
	rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists", string(over), testutil.AuthHeader(tok))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("over-cap name status = %d, want 400: %s", rec.Code, respBody)
	}
	if n, _ := app.CountRecords("lists"); n != 0 {
		t.Errorf("lists = %d after a refused create, want 0", n)
	}

	at, _ := json.Marshal(map[string]string{"name": strings.Repeat("x", max)})
	rec, respBody = testutil.DoReq(mux, http.MethodPost, "/api/lists", string(at), testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("at-cap name status = %d, want 200: %s", rec.Code, respBody)
	}
	assertListName(t, app, listIDOf(t, respBody), strings.Repeat("x", max))
}

// assertListName checks the lists row's one name ([D-08]).
func assertListName(t *testing.T, app core.App, listID, want string) {
	t.Helper()
	rec, err := app.FindRecordById("lists", listID)
	if err != nil {
		t.Fatalf("find list %q: %v", listID, err)
	}
	if got := rec.GetString("name"); got != want {
		t.Errorf("lists.name = %q, want %q", got, want)
	}
}

// listIDOf pulls the new list's id out of a create/clone/import response.
// The SERVER mints it ([D-08]), so a test cannot know it in advance — it
// reads it back the same way the client does.
func listIDOf(t *testing.T, respBody string) string {
	t.Helper()
	var r struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(respBody), &r); err != nil || r.ID == "" {
		t.Fatalf("response carries no list id: %s", respBody)
	}
	return r.ID
}
