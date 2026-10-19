package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	_ "shoppinglist/migrations"
	"shoppinglist/seed"
)

// seedJSONCount returns the number of top-level entries in a seed JSON file,
// read relative to this package dir (backend/). The counts are derived from the
// JSON at test time so a seed append must not require touching this file
// (architecture-pass §7a).
func seedJSONCount(t *testing.T, rel string) int {
	t.Helper()
	raw, err := os.ReadFile(rel)
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("unmarshal %s: %v", rel, err)
	}
	return len(rows)
}

// setupIntegrationApp bootstraps a temp app, applies all migrations, runs the
// seeder, and creates: alice (member of a list with one item + one invite) and
// bob (a non-member). Returns the app plus the two accounts, the list, and the item.
func setupIntegrationApp(t *testing.T) (app *pocketbase.PocketBase, alice, bob, list, item *core.Record) {
	t.Helper()
	app = pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := seed.Run(app); err != nil {
		t.Fatalf("seed: %v", err)
	}

	accCol, _ := app.FindCollectionByNameOrId("accounts")
	listCol, _ := app.FindCollectionByNameOrId("lists")
	memCol, _ := app.FindCollectionByNameOrId("memberships")
	itemCol, _ := app.FindCollectionByNameOrId("items")
	inviteCol, _ := app.FindCollectionByNameOrId("invites")

	mkAcct := func(handle, email string) *core.Record {
		r := core.NewRecord(accCol)
		r.Set("handle", handle)
		r.Set("nickname", handle)
		r.Set("email", email)
		r.SetRandomPassword()
		if err := app.SaveNoValidate(r); err != nil {
			t.Fatalf("save account %s: %v", handle, err)
		}
		return r
	}
	alice = mkAcct("alice", "alice@example.com")
	bob = mkAcct("bob", "bob@example.com")

	list = core.NewRecord(listCol)
	if err := app.SaveNoValidate(list); err != nil {
		t.Fatalf("save list: %v", err)
	}

	mem := core.NewRecord(memCol)
	mem.Set("account", alice.Id)
	mem.Set("list", list.Id)
	if err := app.SaveNoValidate(mem); err != nil {
		t.Fatalf("save membership: %v", err)
	}

	item = core.NewRecord(itemCol)
	item.Set("list", list.Id)
	item.Set("name", "milk")
	if err := app.SaveNoValidate(item); err != nil {
		t.Fatalf("save item: %v", err)
	}

	invite := core.NewRecord(inviteCol)
	invite.Set("list", list.Id)
	invite.Set("token_hash", "deadbeef-"+alice.Id)
	invite.Set("created_by", alice.Id)
	if err := app.SaveNoValidate(invite); err != nil {
		t.Fatalf("save invite: %v", err)
	}
	return app, alice, bob, list, item
}

func req(mux http.Handler, method, url, token, body string) (*httptest.ResponseRecorder, string) {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, url, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, url, nil)
	}
	if token != "" {
		r.Header.Set("Authorization", token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec, rec.Body.String()
}

func getTotal(body string) int {
	var resp struct {
		TotalItems int `json:"totalItems"`
	}
	_ = json.Unmarshal([]byte(body), &resp)
	return resp.TotalItems
}

// TestPhase1Integration verifies the §11 API rules end-to-end against the real
// HTTP layer: membership-gated reads (list + single-record view), deny-on-write
// for shared collections, self-only account visibility, and authenticated-only
// reads of the global reference collections (category_templates / item_dictionary).
func TestPhase1Integration(t *testing.T) {
	app, alice, bob, list, _ := setupIntegrationApp(t)

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	tokA, _ := alice.NewAuthToken()
	tokB, _ := bob.NewAuthToken()

	get := func(url, token string) string {
		_, b := req(mux, http.MethodGet, url, token, "")
		return b
	}
	assertTotal := func(url, token string, want int) {
		t.Helper()
		if got := getTotal(get(url, token)); got != want {
			t.Errorf("%s totalItems = %d, want %d", url, got, want)
		}
	}
	assertStatus := func(method, url, token, body string, want int) {
		t.Helper()
		rec, _ := req(mux, method, url, token, body)
		if rec.Code != want {
			t.Errorf("%s %s: status = %d, want %d", method, url, rec.Code, want)
		}
	}
	deny := func(method, url, token string) {
		t.Helper()
		assertStatus(method, url, token, "{}", http.StatusForbidden)
	}

	// §11: global reference collections are readable by ANY authenticated user
	// (a non-member included), but not by anonymous callers. Expected counts are
	// derived from the seed JSON (see seedJSONCount) so a seed append must not
	// require touching this file.
	// Go tests run with CWD = the package dir (backend/), and the seed JSONs
	// live at backend/seed/ — derived, not hardcoded, so a seed append never
	// requires touching this file.
	assertTotal("/api/collections/category_templates/records", tokB, seedJSONCount(t, "seed/categories.json"))
	assertTotal("/api/collections/item_dictionary/records", tokB, seedJSONCount(t, "seed/items.json"))
	if got := getTotal(get("/api/collections/item_dictionary/records", "")); got != 0 {
		t.Errorf("anonymous item_dictionary totalItems = %d, want 0 (authenticated-only)", got)
	}

	// §11 membership gate (list + view): the member sees the list, its item, and
	// its invite; the non-member sees none of them.
	assertTotal("/api/collections/items/records", tokA, 1)
	assertTotal("/api/collections/items/records", tokB, 0)
	assertTotal("/api/collections/lists/records", tokA, 1)
	assertTotal("/api/collections/lists/records", tokB, 0)
	assertTotal("/api/collections/invites/records", tokA, 1)
	assertTotal("/api/collections/invites/records", tokB, 0)
	// single-record view is governed by ViewRule (= ListRule): member may view the
	// item, non-member is denied (404, since the row is filtered out of their view).
	itemIDs := struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}{}
	_ = json.Unmarshal([]byte(get("/api/collections/items/records", tokA)), &itemIDs)
	if len(itemIDs.Items) == 0 {
		t.Fatal("member sees no items; cannot test single-record view")
	}
	singleURL := "/api/collections/items/records/" + itemIDs.Items[0].ID
	assertStatus(http.MethodGet, singleURL, tokA, "", http.StatusOK)
	assertStatus(http.MethodGet, singleURL, tokB, "", http.StatusNotFound)

	// §11 self-only: each account sees only its own account row + own credentials.
	assertTotal("/api/collections/accounts/records", tokA, 1)
	assertTotal("/api/collections/accounts/records", tokB, 1)
	assertTotal("/api/collections/credentials/records", tokA, 0)

	// §11 deny-on-write: shared collections are route/sync-push only.
	deny(http.MethodPost, "/api/collections/items/records", tokA)
	deny(http.MethodPost, "/api/collections/list_categories/records", tokA)
	deny(http.MethodPost, "/api/collections/memberships/records", tokA)
	deny(http.MethodPost, "/api/collections/lists/records", tokA)
	deny(http.MethodPost, "/api/collections/accounts/records", tokA)
	deny(http.MethodPost, "/api/collections/credentials/records", tokA)
	// invites: create/update are member-gated (tested via assertTotal above), but
	// delete is denied for everyone (route/§7.1 only).
	deny(http.MethodDelete, "/api/collections/invites/records/abc", tokA)
	if rec, _ := req(mux, http.MethodDelete, "/api/collections/items/records/"+list.Id, tokA, ""); rec.Code != http.StatusForbidden {
		t.Errorf("DELETE items: status = %d, want 403", rec.Code)
	}

	// [D-76] oidc_identities, the label settings shows for an OIDC login, is
	// server-managed (nil rules -> superuser only).
	assertStatus(http.MethodGet, "/api/collections/oidc_identities/records", tokA, "", http.StatusForbidden)
}
