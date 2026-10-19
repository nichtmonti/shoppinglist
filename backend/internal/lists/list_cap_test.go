package lists

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/testutil"
)

// [D-217] Under a list cap lower than the backup cap, an import may bring only
// as many items as the cap: up to it imports, one past it is refused.
func TestImportList_FollowsLoweredCap(t *testing.T) {
	app, mux := setupListsAppWith(t, listcap.Caps{Items: 3, Lists: listcap.DefaultMaxLists})
	_, tok := testutil.CreateAccount(t, app, "Alice")

	backup := validBackup() // three items
	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok)); rec.Code != http.StatusOK {
		t.Fatalf("import at the cap: status = %d, want 200: %s", rec.Code, body)
	}

	items := backup["items"].([]any)
	backup["items"] = append(items, map[string]any{
		"name": "d", "quantity": "1", "note": nil, "category_key": nil, "barcode": nil, "image_url": nil,
	})
	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok)); rec.Code != http.StatusBadRequest {
		t.Fatalf("import past the cap: status = %d, want 400: %s", rec.Code, body)
	}
}

// [D-217] A clone is refused when its source holds more living items than the
// cap — possible only after the cap was lowered. Tombstones are not copied, so
// they do not count against the copy.
func TestCloneList_FollowsLoweredCap(t *testing.T) {
	for _, tc := range []struct{ cap, want int }{{2, http.StatusOK}, {1, http.StatusBadRequest}} {
		app, mux := setupListsAppWith(t, listcap.Caps{Items: tc.cap, Lists: listcap.DefaultMaxLists})
		aliceID, tok := testutil.CreateAccount(t, app, "Alice")
		srcID := testutil.CreateList(t, app, "Familie")
		testutil.AddMembership(t, app, aliceID, srcID)
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "a") })
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "b") })
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "c"); r.Set("deleted_at", types.NowDateTime()) })

		rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", `{"name":"Kopie"}`, testutil.AuthHeader(tok))
		if rec.Code != tc.want {
			t.Errorf("clone of two living items under a cap of %d: status = %d, want %d", tc.cap, rec.Code, tc.want)
		}
	}
}

// assertListLimit checks a refusal is the [D-219] answer the client
// recognises, the field contract's status and code, and the cap it names to
// the user.
func assertListLimit(t *testing.T, what string, code int, body string, max int) {
	t.Helper()
	wantStatus, wantCode := fieldcontract.ListLimit()
	if code != wantStatus {
		t.Fatalf("%s at the lists cap: status = %d, want %d: %s", what, code, wantStatus, body)
	}
	var resp struct {
		Code string `json:"code"`
		Max  int    `json:"max"`
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil || resp.Code != wantCode || resp.Max != max {
		t.Errorf("%s at the lists cap: body = %s, want code %s and max %d", what, body, wantCode, max)
	}
}

// [D-219] Create, import and clone all refuse a list past the cap, and the
// lists an account merely joined count toward it.
func TestListsCap_CreateImportCloneRefusedAtTheCap(t *testing.T) {
	app, mux := setupListsAppWith(t, listcap.Caps{Items: listcap.Default().Items, Lists: 2})
	aliceID, tok := testutil.CreateAccount(t, app, "Alice")

	// One list of her own…
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists", `{"name":"Eigene"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("first create: status = %d, want 200: %s", rec.Code, body)
	}
	own := listIDOf(t, body)
	// …and one she joined: that is two, the cap.
	testutil.AddMembership(t, app, aliceID, testutil.CreateList(t, app, "Geteilt"))

	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/lists", `{"name":"Dritte"}`, testutil.AuthHeader(tok))
	assertListLimit(t, "create", rec.Code, body, 2)
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", validBackup()), testutil.AuthHeader(tok))
	assertListLimit(t, "import", rec.Code, body, 2)
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/lists/"+own+"/clone", `{"name":"Kopie"}`, testutil.AuthHeader(tok))
	assertListLimit(t, "clone", rec.Code, body, 2)

	// Nothing was half-made: still exactly her two memberships and lists.
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"account": aliceID}); n != 2 {
		t.Errorf("memberships = %d after three refusals, want 2", n)
	}
	if n, _ := app.CountRecords("lists"); n != 2 {
		t.Errorf("lists = %d after three refusals, want 2", n)
	}
}

// [D-219] The cap is per account: Alice at hers does not stop Bob.
func TestListsCap_PerAccount(t *testing.T) {
	app, mux := setupListsAppWith(t, listcap.Caps{Items: listcap.Default().Items, Lists: 1})
	_, aliceTok := testutil.CreateAccount(t, app, "Alice")
	_, bobTok := testutil.CreateAccount(t, app, "Bob")

	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists", `{"name":"A"}`, testutil.AuthHeader(aliceTok)); rec.Code != http.StatusOK {
		t.Fatalf("Alice's create: status = %d: %s", rec.Code, body)
	}
	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists", `{"name":"B"}`, testutil.AuthHeader(bobTok)); rec.Code != http.StatusOK {
		t.Errorf("Bob's create with Alice at her cap: status = %d, want 200: %s", rec.Code, body)
	}
}
