package lists

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// TestRosterHappyPath (§7.4): two members on a list -> the roster route
// returns both, with correct nicknames.
func TestRosterHappyPath(t *testing.T) {
	app, mux := setupListsApp(t)
	listID := testutil.CreateList(t, app, "")

	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, _ := testutil.CreateAccount(t, app, "Bob")
	testutil.AddMembership(t, app, acctA, listID)
	testutil.AddMembership(t, app, acctB, listID)

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/lists/"+listID+"/members", "", testutil.AuthHeader(tokA))
	if rec.Code != http.StatusOK {
		t.Fatalf("roster status = %d, want 200: %s", rec.Code, body)
	}
	if !strings.Contains(body, acctA) || !strings.Contains(body, "Alice") {
		t.Errorf("roster body missing account A / nickname Alice: %s", body)
	}
	if !strings.Contains(body, acctB) || !strings.Contains(body, "Bob") {
		t.Errorf("roster body missing account B / nickname Bob: %s", body)
	}
}

// TestRosterDeniedForNonMember (§7.4): an authenticated account that is NOT a
// member of the list gets 403, and the response never names a member or the
// list.
func TestRosterDeniedForNonMember(t *testing.T) {
	app, mux := setupListsApp(t)
	listID := testutil.CreateList(t, app, "Secret List Name")

	acctA, _ := testutil.CreateAccount(t, app, "Alice")
	testutil.AddMembership(t, app, acctA, listID)

	_, outsiderTok := testutil.CreateAccount(t, app, "Outsider")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/lists/"+listID+"/members", "", testutil.AuthHeader(outsiderTok))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-member roster status = %d, want 403: %s", rec.Code, body)
	}
	if strings.Contains(body, "Secret List Name") || strings.Contains(body, "Alice") || strings.Contains(body, acctA) {
		t.Errorf("denied response leaked the list's name or a member: %s", body)
	}
}

// TestRosterUnauthenticated: no Authorization header -> 401.
func TestRosterUnauthenticated(t *testing.T) {
	app, mux := setupListsApp(t)
	listID := testutil.CreateList(t, app, "")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/lists/"+listID+"/members", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated roster status = %d, want 401: %s", rec.Code, body)
	}
}

// TestRosterNonexistentListRejectedSameAsNonMember (§7.4): a listId that
// doesn't exist at all gets the identical 403 as "not a member" — the route
// must not be usable to enumerate list existence.
func TestRosterNonexistentListRejectedSameAsNonMember(t *testing.T) {
	app, mux := setupListsApp(t)
	_, tok := testutil.CreateAccount(t, app, "Solo")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/lists/"+randid.ID()+"/members", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("nonexistent-list roster status = %d, want 403: %s", rec.Code, body)
	}
}

// The roster's exact shape, in membership order: account, nickname (empty for
// an account that no longer exists), and the membership's created time.
func TestRosterExactShape(t *testing.T) {
	app, mux := setupListsApp(t)
	listID := testutil.CreateList(t, app, "")
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	gone := randid.ID()
	acctB, _ := testutil.CreateAccount(t, app, "Bob")
	testutil.AddMembership(t, app, acctA, listID)
	testutil.AddMembership(t, app, gone, listID)
	testutil.AddMembership(t, app, acctB, listID)

	mems, err := app.FindAllRecords("memberships", dbx.HashExp{"list": listID})
	if err != nil {
		t.Fatal(err)
	}
	nick := map[string]string{acctA: "Alice", gone: "", acctB: "Bob"}
	want := make([]map[string]any, 0, len(mems))
	for _, m := range mems {
		want = append(want, map[string]any{
			"account": m.GetString("account"), "nickname": nick[m.GetString("account")], "joined": m.GetDateTime("created"),
		})
	}
	wantJSON, _ := json.Marshal(want)

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/lists/"+listID+"/members", "", testutil.AuthHeader(tokA))
	if rec.Code != http.StatusOK {
		t.Fatalf("roster status = %d: %s", rec.Code, body)
	}
	if strings.TrimSpace(body) != string(wantJSON) {
		t.Errorf("roster =\n%s\nwant\n%s", body, wantJSON)
	}
}
