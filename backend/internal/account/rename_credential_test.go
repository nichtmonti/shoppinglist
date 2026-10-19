package account

import (
	"net/http"
	"testing"

	"shoppinglist/internal/testutil"
)

// TestRenameCredentialHappyPath: authenticated owner can rename their credential
// and the response reflects the new value.
func TestRenameCredentialHappyPath(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)
	cred.Set("friendly_name", "old")
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatalf("set initial friendly_name: %v", err)
	}

	reqBody := `{"friendly_name":"iPhone 15"}`
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/credentials/"+cred.Id+"/rename", reqBody, testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("rename status = %d, want 200: %s", rec.Code, body)
	}

	// Stored record is updated
	updated, err := app.FindRecordById("credentials", cred.Id)
	if err != nil {
		t.Fatalf("find credential: %v", err)
	}
	if got := updated.GetString("friendly_name"); got != "iPhone 15" {
		t.Errorf("stored friendly_name = %q, want iPhone 15", got)
	}
}

// TestRenameCredentialByDifferentAccount: a different account's token cannot
// rename a credential they don't own — returns 404 (not-owned, no enumeration).
func TestRenameCredentialByDifferentAccount(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acctA, _ := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acctA.Id)
	cred.Set("friendly_name", "old")
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatalf("set initial friendly_name: %v", err)
	}

	_, tokB := createAccount(t, app, "Bob", "")
	reqBody := `{"friendly_name":"Stolen"}`
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/credentials/"+cred.Id+"/rename", reqBody, testutil.AuthHeader(tokB))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-account rename status = %d, want 404: %s", rec.Code, body)
	}

	// Friendly_name unchanged
	unchanged, err := app.FindRecordById("credentials", cred.Id)
	if err != nil {
		t.Fatalf("find credential: %v", err)
	}
	if got := unchanged.GetString("friendly_name"); got != "old" {
		t.Errorf("friendly_name changed to %q despite not being the owner", got)
	}
}

// TestRenameCredentialUnauthenticated: no token → 401, nothing renamed.
func TestRenameCredentialUnauthenticated(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, _ := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)
	cred.Set("friendly_name", "old")
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatalf("set initial friendly_name: %v", err)
	}

	reqBody := `{"friendly_name":"Unauthed"}`
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/credentials/"+cred.Id+"/rename", reqBody, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated rename status = %d, want 401: %s", rec.Code, body)
	}

	// Friendly_name unchanged
	unchanged, err := app.FindRecordById("credentials", cred.Id)
	if err != nil {
		t.Fatalf("find credential: %v", err)
	}
	if got := unchanged.GetString("friendly_name"); got != "old" {
		t.Errorf("friendly_name changed to %q despite being unauthenticated", got)
	}
}

// TestRenameCredentialTooLong: friendly_name longer than 64 characters is
// rejected with 400.
func TestRenameCredentialTooLong(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)
	cred.Set("friendly_name", "old")
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatalf("set initial friendly_name: %v", err)
	}

	// 65 characters
	longName := "12345678901234567890123456789012345678901234567890123456789012345"
	if len(longName) != 65 {
		t.Fatalf("test setup error: longName length = %d, want 65", len(longName))
	}
	reqBody := `{"friendly_name":"` + longName + `"}`
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/credentials/"+cred.Id+"/rename", reqBody, testutil.AuthHeader(tok))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized friendly_name status = %d, want 400: %s", rec.Code, body)
	}

	// Friendly_name unchanged
	unchanged, err := app.FindRecordById("credentials", cred.Id)
	if err != nil {
		t.Fatalf("find credential: %v", err)
	}
	if got := unchanged.GetString("friendly_name"); got != "old" {
		t.Errorf("friendly_name changed to %q despite being too long", got)
	}
}

// TestRenameCredentialMissingID: a request with an empty/absent {id} segment
// never reaches the handler — the router normalizes the double-slash path with
// a 307 redirect before routing, and `/api/credentials/rename` matches no route
// (404) — so renameCredential needs no check of its own for an empty id.
func TestRenameCredentialMissingID(t *testing.T) {
	app, mux := setupDeleteApp(t)
	_, tok := createAccount(t, app, "Alice", "")

	reqBody := `{"friendly_name":"iPhone 15"}`
	auth := testutil.AuthHeader(tok)

	// Double-slash: router normalizes → redirect, not a rename.
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/credentials//rename", reqBody, auth)
	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("empty-id path status = %d, want 307 (router normalization)", rec.Code)
	}

	// No id at all: matches no registered route → 404.
	rec2, body := testutil.DoReq(mux, http.MethodPost, "/api/credentials/rename", reqBody, auth)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("missing-id path status = %d, want 404: %s", rec2.Code, body)
	}
}

// TestRenameCredentialInvalidJSON: malformed request body returns 400.
func TestRenameCredentialInvalidJSON(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)

	reqBody := `not json`
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/credentials/"+cred.Id+"/rename", reqBody, testutil.AuthHeader(tok))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d, want 400: %s", rec.Code, body)
	}
}
