package oidc

import (
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"

	"shoppinglist/internal/oidclogin"
	"shoppinglist/internal/testutil"
)

// The [D-76] identity label and the unlink, driven through Dex: the label the
// login hook stores and the methods endpoint reports, and what an OIDC sign-in
// does once its login has been removed.

// TestOidcLoginStoresTheIdentityLabel: the first sign-in stores the label, the
// methods endpoint reports it to the account's own session, and a later
// sign-in refreshes it. Dex's password database sends no preferred_username,
// so the label is the address — which the account row itself still never
// holds ([D-25]).
func TestOidcLoginStoresTheIdentityLabel(t *testing.T) {
	app, mux, dex := setupFlowApp(t, anna)

	out := login(t, mux, dex, anna)
	if out.Record.Email != "" {
		t.Errorf("the account row holds the address %q ([D-25])", out.Record.Email)
	}
	if got, _ := oidclogin.Identity(app, out.Record.Id); got != anna.Email {
		t.Fatalf("stored label = %q, want %q", got, anna.Email)
	}
	if got := getMethods(t, mux, testutil.AuthHeader(out.Token)).Oidc.Identity; got != anna.Email {
		t.Errorf("methods identity = %q, want %q", got, anna.Email)
	}
	if got := getMethods(t, mux, nil).Oidc.Identity; got != "" {
		t.Errorf("signed-out methods carry an identity %q", got)
	}

	// A stale label (the provider renamed the user) is replaced on the next
	// sign-in, which takes PocketBase's existing-record branch.
	if err := oidclogin.SetIdentity(app, out.Record.Id, "old-name"); err != nil {
		t.Fatalf("seed stale label: %v", err)
	}
	again := login(t, mux, dex, anna)
	if again.Record.Id != out.Record.Id {
		t.Fatalf("re-login landed on %s, want %s", again.Record.Id, out.Record.Id)
	}
	if got, _ := oidclogin.Identity(app, out.Record.Id); got != anna.Email {
		t.Errorf("label after re-login = %q, want it refreshed to %q", got, anna.Email)
	}
	if n, _ := app.CountRecords("oidc_identities", dbx.HashExp{"account": out.Record.Id}); n != 1 {
		t.Errorf("account has %d label rows, want 1", n)
	}
}

// TestOidcSignInAfterUnlinkCreatesANewAccount is the consequence settings
// warns about: once the login is removed, the provider subject maps to no
// account, so the next OIDC sign-in creates a fresh one — and the unlinked
// account, its passkey and its lists are untouched.
func TestOidcSignInAfterUnlinkCreatesANewAccount(t *testing.T) {
	app, mux, dex := setupLinkApp(t, anna)

	first := login(t, mux, dex, anna)
	testutil.CreateCredential(t, app, first.Record.Id)
	list := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, first.Record.Id, list)

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/unlink", "", testutil.AuthHeader(first.Token))
	if rec.Code != http.StatusOK {
		t.Fatalf("unlink = %d, want 200: %s", rec.Code, body)
	}
	if m := getMethods(t, mux, testutil.AuthHeader(first.Token)).Oidc; m.Linked || m.Identity != "" {
		t.Errorf("methods after unlink = linked %v, identity %q; want neither", m.Linked, m.Identity)
	}

	second := login(t, mux, dex, anna)
	if second.Record.Id == first.Record.Id {
		t.Fatal("the unlinked account still answers the provider subject")
	}
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"account": first.Record.Id, "list": list}); n != 1 {
		t.Errorf("unlinked account lost its list membership")
	}
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"account": second.Record.Id}); n != 0 {
		t.Errorf("the new account has %d memberships, want none", n)
	}
}
