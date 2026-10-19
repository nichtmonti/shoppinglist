package sectest

import (
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"

	"shoppinglist/internal/testutil"
)

// The field-pinning guards added alongside the authorization fixes must not
// break the two updates the client legitimately performs. Both go through the
// same REST endpoint the app's PocketBase SDK calls.

// frontend src/lib/actions/lists.ts renameList: the name is the list's
// ([D-08]), and any member renames it through lists.UpdateRule — every member,
// not only the one who made it.
func TestMemberCanRenameList(t *testing.T) {
	app, mux := setup(t)

	aliceID, _ := testutil.CreateAccount(t, app, "Alice")
	bobID, bobTok := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateList(t, app, "Familie")
	testutil.AddMembership(t, app, aliceID, listID) // the creator
	testutil.AddMembership(t, app, bobID, listID)   // a joiner

	code, body := do(mux, http.MethodPatch,
		"/api/collections/lists/records/"+listID,
		`{"name":"Wocheneinkauf"}`, bobTok)
	if code != 200 {
		t.Fatalf("rename refused: %d %s", code, body)
	}

	after, err := app.FindRecordById("lists", listID)
	if err != nil {
		t.Fatalf("refetch: %v", err)
	}
	if got := after.GetString("name"); got != "Wocheneinkauf" {
		t.Errorf("name = %q, want %q", got, "Wocheneinkauf")
	}
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"list": listID}); n != 2 {
		t.Errorf("memberships = %d after a rename, want 2", n)
	}
}

// The legitimate share-sheet flow must still work end to end: any member can
// mint the list's link and revoke it again.
//
// Both halves are server routes ([D-31]; the collection's CreateRule and
// UpdateRule are nil), exercised here as the share sheet calls them (frontend
// src/lib/actions/invites.ts).
func TestInviteMintAndRevokeStillAllowed(t *testing.T) {
	app, mux := setupRoutes(t)

	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, acctID, listID)

	code, body := do(mux, http.MethodPost, "/api/lists/"+listID+"/invite", "", tok)
	if code != 200 {
		t.Fatalf("mint refused: %d %s", code, body)
	}

	inv, err := app.FindFirstRecordByFilter("invites", "list = {:l}", dbx.Params{"l": listID})
	if err != nil {
		t.Fatalf("find invite: %v", err)
	}
	if inv.GetBool("revoked") {
		t.Fatal("freshly minted invite is already revoked")
	}

	code, body = do(mux, http.MethodPost, "/api/lists/"+listID+"/invite/revoke", "", tok)
	if code != 200 {
		t.Fatalf("revoke refused: %d %s", code, body)
	}

	after, err := app.FindRecordById("invites", inv.Id)
	if err != nil {
		t.Fatalf("refetch: %v", err)
	}
	if !after.GetBool("revoked") {
		t.Error("invite not revoked")
	}
}
