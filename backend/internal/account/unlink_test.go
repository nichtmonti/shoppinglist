package account

import (
	"net/http"
	"sync"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/oidclogin"
	"shoppinglist/internal/testutil"
)

// The [D-76] unlink: POST /api/account/unlink removes the caller's OIDC login
// and its stored label, and refuses while it is the account's only way in.

func setupUnlinkApp(t *testing.T, passkeys bool) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) { RegisterRoutes(r, Options{Passkeys: passkeys}) })
	Register(app, Options{Passkeys: passkeys})
	setOidc(t, app, true)
	return app, mux
}

// oidcAccount creates an account with an OIDC login and a stored label, plus
// `passkeys` credentials; it returns the account id and a session token.
func oidcAccount(t *testing.T, app core.App, passkeys int) (string, string) {
	t.Helper()
	id, tok := testutil.CreateAccount(t, app, "Anna")
	for range passkeys {
		testutil.CreateCredential(t, app, id)
	}
	col, _ := app.FindCollectionByNameOrId("accounts")
	link := core.NewExternalAuth(app)
	link.SetCollectionRef(col.Id)
	link.SetRecordRef(id)
	link.SetProvider(oidclogin.ProviderName)
	link.SetProviderId("sub-" + id)
	if err := app.Save(link); err != nil {
		t.Fatalf("save external auth: %v", err)
	}
	if err := oidclogin.SetIdentity(app, id, "anna"); err != nil {
		t.Fatalf("store identity: %v", err)
	}
	return id, tok
}

func unlink(mux http.Handler, tok string) (int, string) {
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/unlink", "", testutil.AuthHeader(tok))
	return rec.Code, body
}

func assertOidcLogin(t *testing.T, app core.App, accountID string, want bool) {
	t.Helper()
	acct, err := app.FindRecordById("accounts", accountID)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	has, err := oidclogin.HasLogin(app, acct)
	if err != nil {
		t.Fatalf("HasLogin: %v", err)
	}
	if has != want {
		t.Errorf("account has an OIDC login = %v, want %v", has, want)
	}
}

func TestUnlinkRemovesTheLoginAndItsLabel(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, tok := oidcAccount(t, app, 1)

	if code, body := unlink(mux, tok); code != http.StatusOK {
		t.Fatalf("unlink = %d, want 200: %s", code, body)
	}
	assertOidcLogin(t, app, id, false)
	if label, _ := oidclogin.Identity(app, id); label != "" {
		t.Errorf("identity label survived the unlink: %q", label)
	}
	if _, err := app.FindRecordById("accounts", id); err != nil {
		t.Errorf("the account itself went: %v", err)
	}
	if n, _ := app.CountRecords("credentials", dbx.HashExp{"account": id}); n != 1 {
		t.Errorf("account has %d passkeys after the unlink, want 1", n)
	}
	// The session that asked stays valid: removing a login ends no session.
	if code, body := unlink(mux, tok); code != http.StatusNotFound {
		t.Errorf("second unlink = %d, want 404 (nothing left to remove): %s", code, body)
	}
}

func TestUnlinkRefusesWithoutAPasskey(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, tok := oidcAccount(t, app, 0)

	if code, body := unlink(mux, tok); code != http.StatusConflict {
		t.Fatalf("unlink of the only login = %d, want 409: %s", code, body)
	}
	assertOidcLogin(t, app, id, true)
	if label, _ := oidclogin.Identity(app, id); label != "anna" {
		t.Errorf("identity label after a refused unlink = %q, want it kept", label)
	}
}

func TestUnlinkRefusesWhilePasskeysAreOff(t *testing.T) {
	app, mux := setupUnlinkApp(t, false)
	// A passkey on file does not help: with passkeys off it opens nothing.
	id, tok := oidcAccount(t, app, 1)

	if code, body := unlink(mux, tok); code != http.StatusConflict {
		t.Fatalf("unlink with passkeys off = %d, want 409: %s", code, body)
	}
	assertOidcLogin(t, app, id, true)
}

func TestUnlinkIsAbsentWhileOidcIsOff(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, tok := oidcAccount(t, app, 1)
	setOidc(t, app, false)

	if code, body := unlink(mux, tok); code != http.StatusNotFound {
		t.Fatalf("unlink with OIDC off = %d, want 404: %s", code, body)
	}
	assertOidcLogin(t, app, id, true)
}

func TestUnlinkWithoutAnOidcLoginIs404(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, tok := testutil.CreateAccount(t, app, "Bea")
	testutil.CreateCredential(t, app, id)

	if code, body := unlink(mux, tok); code != http.StatusNotFound {
		t.Fatalf("unlink of a passkey-only account = %d, want 404: %s", code, body)
	}
}

func TestUnlinkRequiresAuth(t *testing.T) {
	_, mux := setupUnlinkApp(t, true)
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/unlink", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous unlink = %d, want 401: %s", rec.Code, body)
	}
}

// TestUnlinkLeavesOtherAccountsAlone: only the caller's own login goes.
func TestUnlinkLeavesOtherAccountsAlone(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	_, tok := oidcAccount(t, app, 1)
	other, _ := oidcAccount(t, app, 1)

	if code, body := unlink(mux, tok); code != http.StatusOK {
		t.Fatalf("unlink = %d: %s", code, body)
	}
	assertOidcLogin(t, app, other, true)
	if label, _ := oidclogin.Identity(app, other); label != "anna" {
		t.Errorf("another account's label = %q, want it kept", label)
	}
}

// TestUnlinkAndLastPasskeyDeleteCannotBothPass races the two removals that
// together would leave the account with no way in: the unlink counts passkeys
// inside its transaction, the last-passkey guard counts OIDC logins inside the
// delete's. Whichever commits second must see the first and refuse.
func TestUnlinkAndLastPasskeyDeleteCannotBothPass(t *testing.T) {
	for i := range 10 {
		app, mux := setupUnlinkApp(t, true)
		id, tok := oidcAccount(t, app, 1)
		cred, err := app.FindFirstRecordByFilter("credentials", "account = {:a}", dbx.Params{"a": id})
		if err != nil {
			t.Fatalf("find credential: %v", err)
		}

		var wg sync.WaitGroup
		var unlinked, deleted bool
		wg.Add(2)
		go func() {
			defer wg.Done()
			code, _ := unlink(mux, tok)
			unlinked = code == http.StatusOK
		}()
		go func() {
			defer wg.Done()
			deleted = app.Delete(cred) == nil
		}()
		wg.Wait()

		if unlinked && deleted {
			t.Fatalf("run %d: both the unlink and the last-passkey delete passed — account %s has no way in", i, id)
		}
		if !unlinked && !deleted {
			t.Fatalf("run %d: neither removal passed; one of them should have", i)
		}
	}
}

// TestRecordAPICannotDeleteAnOidcLogin: PocketBase ships `_externalAuths`
// owner-deletable, which let an account strip its own OIDC login past the
// unlink's guard — for an OIDC-only account, its only way in. The record API's
// delete is refused; the account still sees the row.
func TestRecordAPICannotDeleteAnOidcLogin(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, tok := oidcAccount(t, app, 0)
	row, err := app.FindFirstExternalAuthByExpr(dbx.HashExp{"recordRef": id})
	if err != nil {
		t.Fatalf("find external auth: %v", err)
	}

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/collections/_externalAuths/records/"+row.Id, "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Errorf("owner view of the OIDC login = %d, want 200: %s", rec.Code, body)
	}
	rec, body = testutil.DoReq(mux, http.MethodDelete, "/api/collections/_externalAuths/records/"+row.Id, "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusForbidden {
		t.Errorf("owner delete through the record API = %d, want 403: %s", rec.Code, body)
	}
	assertOidcLogin(t, app, id, true)

	// PocketBase's own cascade is a system delete and still takes the row
	// with the account.
	acct, _ := app.FindRecordById("accounts", id)
	if err := DeleteAccount(t.Context(), app, acct); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	if n, _ := app.CountRecords(core.CollectionNameExternalAuths, dbx.HashExp{"recordRef": id}); n != 0 {
		t.Errorf("%d OIDC login rows outlived their account", n)
	}
	if n, _ := app.CountRecords("oidc_identities", dbx.HashExp{"account": id}); n != 0 {
		t.Errorf("%d identity labels outlived their account", n)
	}
}

// TestSuperuserCanDeleteAnOidcLogin ([D-76]): the record API's delete guard
// spares a superuser, the operator's way to take an OIDC login off an account
// from the dashboard (for a login that went to the wrong account, say).
func TestSuperuserCanDeleteAnOidcLogin(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, _ := oidcAccount(t, app, 0)
	row, err := app.FindFirstExternalAuthByExpr(dbx.HashExp{"recordRef": id})
	if err != nil {
		t.Fatalf("find external auth: %v", err)
	}
	_, suTok := createSuperuser(t, app)

	rec, body := testutil.DoReq(mux, http.MethodDelete, "/api/collections/_externalAuths/records/"+row.Id, "", testutil.AuthHeader(suTok))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("superuser delete through the record API = %d, want 204: %s", rec.Code, body)
	}
	assertOidcLogin(t, app, id, false)
}

// TestUnlinkRemovesALoginOfAnyProvider ([D-76]): a login that came through a
// provider added beside "oidc" in the dashboard is the account's OIDC login
// to the methods route, so the unlink removes it too. OAuth2 without the
// "oidc" row is not the instance's OIDC login at all.
func TestUnlinkRemovesALoginOfAnyProvider(t *testing.T) {
	app, mux := setupUnlinkApp(t, true)
	id, tok := testutil.CreateAccount(t, app, "Anna")
	testutil.CreateCredential(t, app, id)
	col, _ := app.FindCollectionByNameOrId("accounts")
	x := core.NewExternalAuth(app)
	x.SetCollectionRef(col.Id)
	x.SetRecordRef(id)
	x.SetProvider("gitea")
	x.SetProviderId("sub-gitea")
	if err := app.Save(x); err != nil {
		t.Fatalf("save external auth: %v", err)
	}

	if code, body := unlink(mux, tok); code != http.StatusOK {
		t.Fatalf("unlink = %d, want 200: %s", code, body)
	}
	assertOidcLogin(t, app, id, false)

	col.OAuth2.Providers[0].Name = "gitea"
	if err := app.Save(col); err != nil {
		t.Fatalf("save accounts: %v", err)
	}
	if name, on := oidclogin.Live(app); on {
		t.Errorf("Live = %q with no %q provider, want off", name, oidclogin.ProviderName)
	}
}
