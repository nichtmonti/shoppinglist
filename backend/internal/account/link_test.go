package account

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/oidclogin"
	"shoppinglist/internal/testutil"
)

// Coverage for the §5.9 [D-76] account link: attach-or-refuse. The OIDC
// login of an EMPTY account B moves onto the caller's account A and B goes;
// a B with lists or passkeys of its own is refused and nothing changes. The
// tests pin both halves, plus the proofs and refusals in front of them.

// addOidcLogin gives accountID an OIDC login for subject, with label as the
// identity settings shows ([D-76]).
func addOidcLogin(t *testing.T, app core.App, accountID, subject, label string) *core.ExternalAuth {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	x := core.NewExternalAuth(app)
	x.SetCollectionRef(col.Id)
	x.SetRecordRef(accountID)
	x.SetProvider(oidclogin.ProviderName)
	x.SetProviderId(subject)
	if err := app.Save(x); err != nil {
		t.Fatalf("save external auth: %v", err)
	}
	if label != "" {
		if err := oidclogin.SetIdentity(app, accountID, label); err != nil {
			t.Fatalf("store identity: %v", err)
		}
	}
	return x
}

// createSuperuser saves a superuser and returns it with an auth token.
func createSuperuser(t *testing.T, app core.App) (*core.Record, string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatalf("find _superusers: %v", err)
	}
	su := core.NewRecord(col)
	su.SetEmail("admin@example.com")
	su.SetPassword("hunter2hunter2")
	if err := app.Save(su); err != nil {
		t.Fatalf("save superuser: %v", err)
	}
	tok, err := su.NewAuthToken()
	if err != nil {
		t.Fatalf("superuser token: %v", err)
	}
	return su, tok
}

func link(t *testing.T, mux http.Handler, callerTok, targetTok string) (int, string) {
	t.Helper()
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/link",
		`{"token":"`+targetTok+`"}`, testutil.AuthHeader(callerTok))
	return rec.Code, body
}

// TestLinkAttachesEmptyOidcAccountToCaller is the contract's main half: the
// caller keeps its id, lists, passkeys and session; the OIDC login and its
// label move onto it; the empty OIDC account is gone.
func TestLinkAttachesEmptyOidcAccountToCaller(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	caller, callerTok := createAccount(t, app, "Anna", "")
	target, targetTok := createAccount(t, app, "Anna (IdP)", "")
	x := addOidcLogin(t, app, target.Id, "sub-anna", "anna@idp")

	lst := testutil.CreateList(t, app, "")
	membership := testutil.AddMembership(t, app, caller.Id, lst)
	cred := testutil.CreateCredential(t, app, caller.Id)

	code, body := link(t, mux, callerTok, targetTok)
	if code != http.StatusOK {
		t.Fatalf("link = %d, want 200: %s", code, body)
	}

	if _, err := app.FindRecordById("accounts", caller.Id); err != nil {
		t.Fatalf("caller account gone after the link: %v", err)
	}
	if _, err := app.FindRecordById("accounts", target.Id); err == nil {
		t.Error("the empty OIDC account survived the link")
	}
	moved, err := app.FindRecordById(core.CollectionNameExternalAuths, x.Id)
	if err != nil {
		t.Fatalf("OIDC login vanished instead of moving: %v", err)
	}
	if got := moved.GetString("recordRef"); got != caller.Id {
		t.Errorf("OIDC login points at %q, want the caller %q", got, caller.Id)
	}
	// Verified, as every OIDC account is: PocketBase's sign-in would otherwise
	// treat the account as pre-hijacked and refuse (internal/oidc/hooks.go).
	if acct, _ := app.FindRecordById("accounts", caller.Id); acct == nil || !acct.Verified() {
		t.Error("caller not marked verified by the link")
	}
	if label, _ := oidclogin.Identity(app, caller.Id); label != "anna@idp" {
		t.Errorf("caller's identity label = %q, want %q", label, "anna@idp")
	}
	if _, err := app.FindRecordById("memberships", membership.Id); err != nil {
		t.Errorf("caller's membership touched: %v", err)
	}
	if c, err := app.FindRecordById("credentials", cred.Id); err != nil || c.GetString("account") != caller.Id {
		t.Errorf("caller's passkey moved or gone (err %v)", err)
	}
	// The session this device holds, and every other device's, stays valid.
	if got, err := app.FindAuthRecordByToken(callerTok, core.TokenTypeAuth); err != nil || got.Id != caller.Id {
		t.Errorf("caller token no longer authenticates the caller (err %v)", err)
	}
	if _, err := app.FindAuthRecordByToken(targetTok, core.TokenTypeAuth); err == nil {
		t.Error("the deleted OIDC account's token still verifies")
	}
}

// TestLinkRefusesOidcAccountWithItsOwnData: a B with lists or passkeys is
// someone's account in use; attaching would delete it, so the link refuses
// and leaves both accounts exactly as they were.
func TestLinkRefusesOidcAccountWithItsOwnData(t *testing.T) {
	cases := map[string]func(t *testing.T, app core.App, targetID string){
		"has a list": func(t *testing.T, app core.App, targetID string) {
			testutil.AddMembership(t, app, targetID, testutil.CreateList(t, app, ""))
		},
		"has a passkey": func(t *testing.T, app core.App, targetID string) {
			testutil.CreateCredential(t, app, targetID)
		},
	}
	for name, seed := range cases {
		t.Run(name, func(t *testing.T) {
			app, mux := setupDeleteApp(t)
			setOidc(t, app, true)
			caller, callerTok := createAccount(t, app, "Anna", "")
			testutil.AddMembership(t, app, caller.Id, testutil.CreateList(t, app, ""))
			target, targetTok := createAccount(t, app, "Anna (IdP)", "")
			x := addOidcLogin(t, app, target.Id, "sub-anna", "anna@idp")
			seed(t, app, target.Id)
			before := map[string]int{
				"caller memberships": testutil.Count(t, app, "memberships", dbx.HashExp{"account": caller.Id}),
				"target memberships": testutil.Count(t, app, "memberships", dbx.HashExp{"account": target.Id}),
				"target credentials": testutil.Count(t, app, "credentials", dbx.HashExp{"account": target.Id}),
			}

			code, body := link(t, mux, callerTok, targetTok)
			if code != http.StatusConflict {
				t.Fatalf("link = %d, want 409: %s", code, body)
			}
			for _, id := range []string{caller.Id, target.Id} {
				if _, err := app.FindRecordById("accounts", id); err != nil {
					t.Errorf("account %s gone after a refused link: %v", id, err)
				}
			}
			if got, err := app.FindRecordById(core.CollectionNameExternalAuths, x.Id); err != nil || got.GetString("recordRef") != target.Id {
				t.Errorf("OIDC login moved by a refused link (err %v)", err)
			}
			after := map[string]int{
				"caller memberships": testutil.Count(t, app, "memberships", dbx.HashExp{"account": caller.Id}),
				"target memberships": testutil.Count(t, app, "memberships", dbx.HashExp{"account": target.Id}),
				"target credentials": testutil.Count(t, app, "credentials", dbx.HashExp{"account": target.Id}),
			}
			for k, v := range before {
				if after[k] != v {
					t.Errorf("%s = %d after a refused link, want %d", k, after[k], v)
				}
			}
		})
	}
}

// TestLinkRefusesCallerWithAnOidcLogin: one OIDC login per account (400 —
// settings offers the link only to an account without one). The caller's own
// login stays, and the other account is left alone.
func TestLinkRefusesCallerWithAnOidcLogin(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	caller, callerTok := createAccount(t, app, "Anna", "")
	own := addOidcLogin(t, app, caller.Id, "sub-anna-old", "")
	target, targetTok := createAccount(t, app, "Anna (IdP)", "")
	x := addOidcLogin(t, app, target.Id, "sub-anna", "")

	code, body := link(t, mux, callerTok, targetTok)
	if code != http.StatusBadRequest {
		t.Fatalf("link = %d, want 400: %s", code, body)
	}
	if _, err := app.FindRecordById("accounts", target.Id); err != nil {
		t.Errorf("other account deleted by a refused link: %v", err)
	}
	for id, owner := range map[string]string{own.Id: caller.Id, x.Id: target.Id} {
		if got, err := app.FindRecordById(core.CollectionNameExternalAuths, id); err != nil || got.GetString("recordRef") != owner {
			t.Errorf("OIDC login %s moved or gone (err %v)", id, err)
		}
	}
}

// TestLinkDatabaseFailureIs500: a failure inside the link's transaction is
// the server's, not the 400 PocketBase gives a bare error ([D-191]).
func TestLinkDatabaseFailureIs500(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	_, callerTok := createAccount(t, app, "Anna", "")
	target, targetTok := createAccount(t, app, "Anna (IdP)", "")
	addOidcLogin(t, app, target.Id, "sub-anna", "")
	if _, err := app.DB().NewQuery("DROP TABLE credentials").Execute(); err != nil {
		t.Fatalf("drop credentials: %v", err)
	}

	if code, body := link(t, mux, callerTok, targetTok); code != http.StatusInternalServerError {
		t.Errorf("link = %d, want 500: %s", code, body)
	}
}

// TestLinkRefusesTargetWithoutOidcLogin: the body token must be an OIDC
// login's; a token for some other account proves nothing to attach.
func TestLinkRefusesTargetWithoutOidcLogin(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	_, callerTok := createAccount(t, app, "Anna", "")
	other, otherTok := createAccount(t, app, "Bob", "")

	code, body := link(t, mux, callerTok, otherTok)
	if code != http.StatusBadRequest {
		t.Fatalf("link = %d, want 400: %s", code, body)
	}
	if _, err := app.FindRecordById("accounts", other.Id); err != nil {
		t.Errorf("other account deleted by a refused link: %v", err)
	}
}

func TestLinkRejectsBadRequests(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	passkey, passkeyTok := createAccount(t, app, "Anna", "")
	oidc, _ := createAccount(t, app, "Bob", "")
	addOidcLogin(t, app, oidc.Id, "sub-bob", "")

	cases := []struct {
		name    string
		body    string
		headers map[string]string
		want    int
	}{
		{"no auth", `{"token":"x"}`, nil, http.StatusUnauthorized},
		{"missing token", `{}`, testutil.AuthHeader(passkeyTok), http.StatusBadRequest},
		{"garbage token", `{"token":"not-a-token"}`, testutil.AuthHeader(passkeyTok), http.StatusUnauthorized},
		{"self link", `{"token":"` + passkeyTok + `"}`, testutil.AuthHeader(passkeyTok), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/link", tc.body, tc.headers)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d: %s", rec.Code, tc.want, body)
			}
			// A refused link must not have torn anything down.
			if _, err := app.FindRecordById("accounts", passkey.Id); err != nil {
				t.Errorf("caller account deleted by a refused link: %v", err)
			}
			if _, err := app.FindRecordById("accounts", oidc.Id); err != nil {
				t.Errorf("target account deleted by a refused link: %v", err)
			}
		})
	}
}

// TestLinkRefusesATargetFromAnotherAuthCollection ([D-76]): the body token
// must be an accounts token. A superuser's, even one with an OIDC login row of
// its own, is refused before anything moves: the link would otherwise hand its
// login to the caller and delete the superuser as the emptied account.
func TestLinkRefusesATargetFromAnotherAuthCollection(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	caller, callerTok := createAccount(t, app, "Anna", "")
	su, suTok := createSuperuser(t, app)
	x := core.NewExternalAuth(app)
	x.SetCollectionRef(su.Collection().Id)
	x.SetRecordRef(su.Id)
	x.SetProvider(oidclogin.ProviderName)
	x.SetProviderId("sub-admin")
	if err := app.Save(x); err != nil {
		t.Fatalf("save superuser's external auth: %v", err)
	}

	code, body := link(t, mux, callerTok, suTok)
	if code != http.StatusBadRequest || !strings.Contains(body, "not an accounts token") {
		t.Fatalf("link = %d %s, want 400 not an accounts token", code, body)
	}
	if _, err := app.FindRecordById(core.CollectionNameSuperusers, su.Id); err != nil {
		t.Errorf("superuser deleted by a refused link: %v", err)
	}
	if got, err := app.FindRecordById(core.CollectionNameExternalAuths, x.Id); err != nil || got.GetString("recordRef") != su.Id {
		t.Errorf("the superuser's login moved or gone (err %v)", err)
	}
	assertOidcLogin(t, app, caller.Id, false)
	after, err := app.FindRecordById("accounts", caller.Id)
	if err != nil {
		t.Fatalf("caller account gone: %v", err)
	}
	if after.Verified() != caller.Verified() || after.TokenKey() != caller.TokenKey() {
		t.Errorf("caller account changed by a refused link: verified %v→%v", caller.Verified(), after.Verified())
	}
}

// TestSuperuserIsNoAccount: a superuser's token (SHOPPINGLIST_ADMIN_UI=on)
// authenticates, but not as an account, so the account routes answer 403
// instead of acting on the superuser record: the delete would delete it.
func TestSuperuserIsNoAccount(t *testing.T) {
	app, mux := setupDeleteApp(t)
	su, suTok := createSuperuser(t, app)

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(suTok))
	if rec.Code != http.StatusForbidden {
		t.Errorf("account delete with a superuser token = %d %s, want 403", rec.Code, body)
	}
	if _, err := app.FindRecordById(core.CollectionNameSuperusers, su.Id); err != nil {
		t.Errorf("superuser deleted by the account route: %v", err)
	}
}

// TestLinkRefusedWhileOidcIsOff ([D-76]): the link exists to attach an OIDC
// login to a passkey account; with OIDC off there is none to attach, so the
// route is not there.
func TestLinkRefusedWhileOidcIsOff(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, false)
	_, passkeyTok := createAccount(t, app, "Anna", "")
	other, otherTok := createAccount(t, app, "Bob", "")
	addOidcLogin(t, app, other.Id, "sub-bob", "")

	code, body := link(t, mux, passkeyTok, otherTok)
	if code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", code, body)
	}
	if _, err := app.FindRecordById("accounts", other.Id); err != nil {
		t.Errorf("other account deleted by a refused link: %v", err)
	}
}
