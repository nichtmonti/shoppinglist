package account

import (
	"context"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// setupAccountApp bootstraps a temp app (via testutil.NewApp) with this
// package's guard hooks registered and PocketBase's full default API surface
// mounted (apis.NewRouter), returning the app and a dispatchable mux.
func setupAccountApp(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) { RegisterRoutes(r, Options{Passkeys: true}) })
	Register(app, Options{Passkeys: true})
	return app, mux
}

// createAccount saves an accounts row directly and returns (record, bearer token).
func createAccount(t *testing.T, app core.App, nickname, email string) (*core.Record, string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Id = randid.ID()
	rec.Set("handle", randid.ID())
	rec.Set("nickname", nickname)
	if email != "" {
		rec.Set("email", email)
	}
	rec.SetRandomPassword()
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save account: %v", err)
	}
	tok, err := rec.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	return rec, tok
}

// TestSelfUpdateAllowsNickname (§11): an authenticated update changing only
// nickname via PocketBase's default collection-record update endpoint succeeds.
func TestSelfUpdateAllowsNickname(t *testing.T) {
	app, mux := setupAccountApp(t)
	acct, tok := createAccount(t, app, "Alice", "")

	rec, body := testutil.DoReq(mux, http.MethodPatch, "/api/collections/accounts/records/"+acct.Id,
		`{"nickname":"Alicia"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("nickname-only update status = %d, want 200: %s", rec.Code, body)
	}

	updated, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if got := updated.GetString("nickname"); got != "Alicia" {
		t.Errorf("nickname = %q, want %q", got, "Alicia")
	}
}

// TestSelfUpdateRejectsHandle (§11): the same request also touching handle
// (a protected field) must be rejected with 403, and handle must be unchanged.
func TestSelfUpdateRejectsHandle(t *testing.T) {
	app, mux := setupAccountApp(t)
	acct, tok := createAccount(t, app, "Alice", "")
	originalHandle := acct.GetString("handle")

	rec, body := testutil.DoReq(mux, http.MethodPatch, "/api/collections/accounts/records/"+acct.Id,
		`{"nickname":"Alicia","handle":"newhandle"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("handle-changing update status = %d, want 403: %s", rec.Code, body)
	}

	updated, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if got := updated.GetString("handle"); got != originalHandle {
		t.Errorf("handle = %q, want unchanged %q", got, originalHandle)
	}
}

// TestSelfUpdateRejectsEmail (§11): same as above but for the email field,
// which PocketBase's own auth-record form refuses to anyone without manage
// access ([D-32]), so no email can be squatted past verification.
func TestSelfUpdateRejectsEmail(t *testing.T) {
	app, mux := setupAccountApp(t)
	acct, tok := createAccount(t, app, "Alice", "")

	rec, body := testutil.DoReq(mux, http.MethodPatch, "/api/collections/accounts/records/"+acct.Id,
		`{"nickname":"Alicia","email":"alice@example.com"}`, testutil.AuthHeader(tok))
	if rec.Code == http.StatusOK {
		t.Fatalf("email-changing update status = %d, want a rejection: %s", rec.Code, body)
	}

	updated, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if got := updated.GetString("email"); got != "" {
		t.Errorf("email = %q, want unchanged empty", got)
	}
}

// TestSelfUpdateLeavesVerifiedAndTokenKey (§11, [D-32]): the rest of the
// identity a user must not write on their own row, refused or ignored by
// PocketBase's own form: verified (no manage access) and the hidden tokenKey.
func TestSelfUpdateLeavesVerifiedAndTokenKey(t *testing.T) {
	app, mux := setupAccountApp(t)
	acct, tok := createAccount(t, app, "Alice", "")
	oldKey := acct.GetString("tokenKey")

	for _, patch := range []string{`{"verified":true}`, `{"tokenKey":"attackerchosentokenkeyvalue00000"}`} {
		testutil.DoReq(mux, http.MethodPatch, "/api/collections/accounts/records/"+acct.Id, patch, testutil.AuthHeader(tok))
	}

	updated, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if updated.Verified() {
		t.Error("verified = true, want unchanged false")
	}
	if got := updated.GetString("tokenKey"); got != oldKey {
		t.Errorf("tokenKey = %q, want unchanged %q", got, oldKey)
	}
}

// TestCredentialGuardBlocksLastCredential (§5.4, [D-32]): an account with
// exactly one credential and no OIDC login must not be allowed to delete it
// directly.
func TestCredentialGuardBlocksLastCredential(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app, Options{Passkeys: true})
	acct, _ := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)

	if err := app.Delete(cred); err == nil {
		t.Fatal("expected delete of last credential (no other login) to be refused, got nil error")
	}
	if rec, err := app.FindRecordById("credentials", cred.Id); err != nil || rec == nil {
		t.Errorf("credential should still exist after refused delete: err=%v rec=%v", err, rec)
	}
}

// TestCredentialGuardAllowsNonLastCredential (§5.4): with two credentials,
// deleting one directly succeeds and the other remains.
func TestCredentialGuardAllowsNonLastCredential(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app, Options{Passkeys: true})
	acct, _ := createAccount(t, app, "Alice", "")
	credA := testutil.CreateCredential(t, app, acct.Id)
	credB := testutil.CreateCredential(t, app, acct.Id)

	if err := app.Delete(credA); err != nil {
		t.Fatalf("delete non-last credential: %v", err)
	}
	if n, err := app.CountRecords("credentials"); err != nil || n != 1 {
		t.Errorf("credentials remaining = %d, want 1 (err=%v)", n, err)
	}
	if rec, err := app.FindRecordById("credentials", credB.Id); err != nil || rec == nil {
		t.Errorf("credB should still exist: err=%v rec=%v", err, rec)
	}
}

// TestCredentialGuardAllowsLastCredentialWithOidcLogin (§5.4, [D-25]): an
// account with an OIDC login may delete its last passkey — the provider still
// opens the account.
// setOidc switches the accounts collection's OAuth2 login on or off, the
// state oidc.Apply derives from SHOPPINGLIST_OIDC at boot.
func setOidc(t *testing.T, app core.App, on bool) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	col.OAuth2.Enabled = on
	col.OAuth2.Providers = []core.OAuth2ProviderConfig{{
		Name: "oidc", ClientId: "c", ClientSecret: "s",
		AuthURL: "https://idp.example.com/auth", TokenURL: "https://idp.example.com/token",
		UserInfoURL: "https://idp.example.com/userinfo",
	}}
	if err := app.Save(col); err != nil {
		t.Fatalf("save accounts: %v", err)
	}
}

// accountWithOidcLogin creates an account with one passkey and an OIDC login.
func accountWithOidcLogin(t *testing.T, app core.App) *core.Record {
	t.Helper()
	acct, _ := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)
	link := core.NewExternalAuth(app)
	link.SetCollectionRef(acct.Collection().Id)
	link.SetRecordRef(acct.Id)
	link.SetProvider("oidc")
	link.SetProviderId("stub-1")
	if err := app.Save(link); err != nil {
		t.Fatalf("save external auth: %v", err)
	}
	return cred
}

func TestCredentialGuardAllowsLastCredentialWithOidcLogin(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app, Options{Passkeys: true})
	setOidc(t, app, true)
	cred := accountWithOidcLogin(t, app)

	if err := app.Delete(cred); err != nil {
		t.Fatalf("delete last credential with an OIDC login should succeed: %v", err)
	}
	if n, err := app.CountRecords("credentials"); err != nil || n != 0 {
		t.Errorf("credentials remaining = %d, want 0 (err=%v)", n, err)
	}
}

// TestCredentialGuardOidcLoginCountsOnlyWhileOidcIsOn ([D-76]): the
// ExternalAuth row outlives SHOPPINGLIST_OIDC=off, but it opens nothing then —
// deleting the last passkey would lock the account out.
func TestCredentialGuardOidcLoginCountsOnlyWhileOidcIsOn(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app, Options{Passkeys: true})
	setOidc(t, app, false)
	cred := accountWithOidcLogin(t, app)

	if err := app.Delete(cred); err == nil {
		t.Fatal("expected delete of the last credential to be refused while OIDC is off")
	}
}

// TestCredentialGuardEmailIsNotALogin ([D-25]): an email on the record opens
// nothing — the app has no email login — so it does not unlock deleting the
// last passkey.
func TestCredentialGuardEmailIsNotALogin(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app, Options{Passkeys: true})
	acct, _ := createAccount(t, app, "Alice", "alice@example.com")
	cred := testutil.CreateCredential(t, app, acct.Id)

	if err := app.Delete(cred); err == nil {
		t.Fatal("expected delete of last credential to be refused: an email is not a login path")
	}
}

// TestBypassCredentialGuardAllowsLastCredential ([D-32]): the internal
// bypass mechanism itself, used via DeleteWithContext, allows deleting the
// last credential of a passkey-only account — independent of the full route.
func TestBypassCredentialGuardAllowsLastCredential(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app, Options{Passkeys: true})
	acct, _ := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)

	ctx := bypassCredentialGuard(context.Background())
	if err := app.DeleteWithContext(ctx, cred); err != nil {
		t.Fatalf("bypassed delete of last credential should succeed: %v", err)
	}
	if n, err := app.CountRecords("credentials"); err != nil || n != 0 {
		t.Errorf("credentials remaining = %d, want 0 (err=%v)", n, err)
	}
}

// TestSelfUpdateAllowsSuppressedNames (§6.11 [D-17], §11): the suggestion-
// suppression list is the second thing the self-update allowlist admits. It is
// written through the ordinary own-row path — never through sync/push — so the
// client must be able to PATCH it on its own accounts record.
func TestSelfUpdateAllowsSuppressedNames(t *testing.T) {
	app, mux := setupAccountApp(t)
	acct, tok := createAccount(t, app, "Alice", "")

	rec, body := testutil.DoReq(mux, http.MethodPatch, "/api/collections/accounts/records/"+acct.Id,
		`{"suppressed_names":["sonnencreme","katzenstreu"]}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("suppressed_names update status = %d, want 200: %s", rec.Code, body)
	}

	updated, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	var got []string
	if err := updated.UnmarshalJSONField("suppressed_names", &got); err != nil {
		t.Fatalf("unmarshal suppressed_names: %v", err)
	}
	if len(got) != 2 || got[0] != "sonnencreme" || got[1] != "katzenstreu" {
		t.Errorf("suppressed_names = %v, want [sonnencreme katzenstreu]", got)
	}
}

// TestSelfUpdateSuppressedNamesDeniedForOtherAccount (§11, §14's "every custom
// route gets a denied test"): the collection UpdateRule scopes the row to its
// owner, so account B cannot write account A's suppression list.
func TestSelfUpdateSuppressedNamesDeniedForOtherAccount(t *testing.T) {
	app, mux := setupAccountApp(t)
	victim, _ := createAccount(t, app, "Alice", "")
	_, attackerTok := createAccount(t, app, "Mallory", "")

	rec, body := testutil.DoReq(mux, http.MethodPatch, "/api/collections/accounts/records/"+victim.Id,
		`{"suppressed_names":["gurke"]}`, testutil.AuthHeader(attackerTok))
	if rec.Code == http.StatusOK {
		t.Fatalf("cross-account suppressed_names update succeeded (status %d): %s", rec.Code, body)
	}

	updated, err := app.FindRecordById("accounts", victim.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if raw := updated.GetString("suppressed_names"); raw != "" && raw != "null" && raw != "[]" {
		t.Errorf("victim suppressed_names = %q, want untouched", raw)
	}
}

// Two concurrent deletes of an account's last two passkeys must not both pass
// the last-credential guard: the count and the delete share one transaction.
func TestCredentialGuardHoldsUnderConcurrentDeletes(t *testing.T) {
	app, _ := setupAccountApp(t)
	for round := range 20 {
		acct, _ := createAccount(t, app, "Alice", "")
		creds := []*core.Record{testutil.CreateCredential(t, app, acct.Id), testutil.CreateCredential(t, app, acct.Id)}

		start := make(chan struct{})
		done := make(chan error, len(creds))
		for _, c := range creds {
			go func(c *core.Record) {
				<-start
				done <- app.Delete(c)
			}(c)
		}
		close(start)
		for range creds {
			<-done
		}

		n, err := app.CountRecords("credentials", dbx.HashExp{"account": acct.Id})
		if err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("round %d: %d credentials left, want 1 — both deletes passed the guard", round, n)
		}
	}
}

// TestCredentialGuardFailureIs500 ([D-191]): a guard that could not count the
// account's other logins answers 500, not the record API's generic 400, and
// deletes nothing.
func TestCredentialGuardFailureIs500(t *testing.T) {
	app, mux := setupAccountApp(t)
	setOidc(t, app, true)
	acct, tok := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)
	if _, err := app.DB().NewQuery("ALTER TABLE " + core.CollectionNameExternalAuths + " RENAME TO gone").Execute(); err != nil {
		t.Fatalf("rename: %v", err)
	}

	rec, body := testutil.DoReq(mux, http.MethodDelete, "/api/collections/credentials/records/"+cred.Id, "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("delete with a failing guard = %d, want 500: %s", rec.Code, body)
	}
	if _, err := app.FindRecordById("credentials", cred.Id); err != nil {
		t.Errorf("credential gone after a failed guard: %v", err)
	}
}
