package account

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	pbsecurity "github.com/pocketbase/pocketbase/tools/security"

	"shoppinglist/internal/lists"
	"shoppinglist/internal/testutil"
)

// setupDeleteApp bootstraps a temp app with this package's guard hooks, the
// §7.3 membership cascade hook (needed so the deletion route's per-membership
// deletes actually cascade solo lists, matching production wiring where
// main.go registers both), and the §4.5 deletion route mounted.
//
// It also mounts /test/sign-in, standing in for the passkey login: it answers
// with PocketBase's auth response for the account in the body, as every
// sign-in does, so its token carries the [D-309] sign-in time.
func setupDeleteApp(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		RegisterRoutes(r, Options{Passkeys: true})
		r.POST("/test/sign-in", func(e *core.RequestEvent) error {
			var body struct{ ID string }
			if err := e.BindBody(&body); err != nil {
				return err
			}
			rec, err := e.App.FindRecordById("accounts", body.ID)
			if err != nil {
				return err
			}
			return apis.RecordAuthResponse(e, rec, "passkey", nil)
		})
	})
	Register(app, Options{Passkeys: true})
	lists.Register(app)
	return app, mux
}

// authToken posts to an auth route and returns the token it answers with.
func authToken(t *testing.T, mux http.Handler, path, body string, headers map[string]string) string {
	t.Helper()
	rec, resp := testutil.DoReq(mux, http.MethodPost, path, body, headers)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s = %d: %s", path, rec.Code, resp)
	}
	var out struct{ Token string }
	if err := json.Unmarshal([]byte(resp), &out); err != nil || out.Token == "" {
		t.Fatalf("%s answered no token: %v %s", path, err, resp)
	}
	return out.Token
}

// signIn is a sign-in from moments ago for accountID ([D-309]).
func signIn(t *testing.T, mux http.Handler, accountID string) string {
	t.Helper()
	return authToken(t, mux, "/test/sign-in", `{"id":"`+accountID+`"}`, nil)
}

// createItem saves an items row for listID, stamping modified_by.
func createItem(t *testing.T, app core.App, listID, name, modifiedBy string) *core.Record {
	t.Helper()
	return testutil.CreateItem(t, app, listID, name, func(r *core.Record) {
		if modifiedBy != "" {
			r.Set("modified_by", modifiedBy)
		}
	})
}

// TestDeleteAccountSoloCascadeSharedSurvives (docs/internals/design.md §4.5): account A has a
// solo list (only A as member) and a shared list (A + B both members), with
// items on both. Deleting A's account via the route must: hard-delete the
// solo list and everything hanging off it (§7.3 cascade fires); leave the
// shared list, B's membership, and the shared list's items (including ones A
// authored, with modified_by left dangling per [D-32]) untouched; remove A's
// accounts row and credentials.
func TestDeleteAccountSoloCascadeSharedSurvives(t *testing.T) {
	app, mux := setupDeleteApp(t)

	acctA, _ := createAccount(t, app, "Alice", "")
	acctB, _ := createAccount(t, app, "Bob", "")
	credA := testutil.CreateCredential(t, app, acctA.Id)

	soloList := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, acctA.Id, soloList)
	createItem(t, app, soloList, "Solo Milk", acctA.Id)
	testutil.CreateListCategory(t, app, soloList, "dairy")
	testutil.CreateInvite(t, app, soloList, "")

	sharedList := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, acctA.Id, sharedList)
	membershipB := testutil.AddMembership(t, app, acctB.Id, sharedList)
	sharedItem := createItem(t, app, sharedList, "Shared Eggs", acctA.Id)

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(signIn(t, mux, acctA.Id)))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200: %s", rec.Code, body)
	}

	// solo list fully gone
	if r, err := app.FindRecordById("lists", soloList); err == nil && r != nil {
		t.Errorf("solo list %q still exists", soloList)
	}
	if n := testutil.Count(t, app, "items", dbx.HashExp{"list": soloList}); n != 0 {
		t.Errorf("solo list items remaining = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "list_categories", dbx.HashExp{"list": soloList}); n != 0 {
		t.Errorf("solo list categories remaining = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "invites", dbx.HashExp{"list": soloList}); n != 0 {
		t.Errorf("solo list invites remaining = %d, want 0", n)
	}

	// shared list survives untouched
	if r, err := app.FindRecordById("lists", sharedList); err != nil || r == nil {
		t.Fatalf("shared list should still exist: err=%v rec=%v", err, r)
	}
	if r, err := app.FindRecordById("memberships", membershipB.Id); err != nil || r == nil {
		t.Errorf("Bob's membership should still exist: err=%v rec=%v", err, r)
	}
	itemRec, err := app.FindRecordById("items", sharedItem.Id)
	if err != nil || itemRec == nil {
		t.Fatalf("shared item should still exist: err=%v rec=%v", err, itemRec)
	}
	// [D-32] calls this a "dangling" modified_by that "renders as someone" —
	// but PocketBase's own built-in delete pipeline
	// (core/record_model.go cascadeRecordDelete/deleteRefRecords) actively
	// UNSETS non-required, non-cascade relation values that point at a
	// just-deleted record (rather than leaving the stale id in place), since
	// e.App.Delete(e.Auth) is a normal framework delete and this cleanup is
	// unconditional, not something a hook in this package can opt out of.
	// The observable intent is preserved either way: the item survives and
	// its author reference no longer resolves to a live account, rendering
	// as "someone" client-side.
	if got := itemRec.GetString("modified_by"); got != "" {
		t.Errorf("shared item modified_by = %q, want cleared (empty) after account deletion", got)
	}

	// A's account + credentials gone
	if r, err := app.FindRecordById("accounts", acctA.Id); err == nil && r != nil {
		t.Errorf("account A %q still exists", acctA.Id)
	}
	if n := testutil.Count(t, app, "credentials", dbx.HashExp{"account": acctA.Id}); n != 0 {
		t.Errorf("credentials remaining for A = %d, want 0", n)
	}
	if r, err := app.FindRecordById("credentials", credA.Id); err == nil && r != nil {
		t.Errorf("credential %q still exists", credA.Id)
	}

	// B untouched
	if r, err := app.FindRecordById("accounts", acctB.Id); err != nil || r == nil {
		t.Errorf("account B should still exist: err=%v rec=%v", err, r)
	}
}

// TestDeleteAccountLastCredentialBypassed (§5.4, [D-32]): a passkey-only
// account with exactly one credential must still be fully deletable via the
// route — proving the bypass is wired end-to-end, not just in isolation.
func TestDeleteAccountLastCredentialBypassed(t *testing.T) {
	app, mux := setupDeleteApp(t)

	acct, _ := createAccount(t, app, "Solo", "")
	cred := testutil.CreateCredential(t, app, acct.Id)

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(signIn(t, mux, acct.Id)))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200: %s", rec.Code, body)
	}

	if r, err := app.FindRecordById("credentials", cred.Id); err == nil && r != nil {
		t.Errorf("last credential %q still exists after account deletion", cred.Id)
	}
	if r, err := app.FindRecordById("accounts", acct.Id); err == nil && r != nil {
		t.Errorf("account %q still exists after deletion", acct.Id)
	}
}

// TestDeleteAccountNeedsAFreshSignIn ([D-309]): an account with a login is
// deleted only by a token from a sign-in in the last five minutes. A session
// token, the token auth-refresh mints from a fresh one, and a sign-in from six
// minutes ago are refused and delete nothing.
func TestDeleteAccountNeedsAFreshSignIn(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true)
	passkey, session := createAccount(t, app, "Passkey", "")
	testutil.CreateCredential(t, app, passkey.Id)
	oidcOnly, oidcSession := createAccount(t, app, "OIDC", "")
	addOidcLogin(t, app, oidcOnly.Id, "sub-oidc", "")

	fresh := signIn(t, mux, passkey.Id)
	refreshed := authToken(t, mux, "/api/collections/accounts/auth-refresh", "", testutil.AuthHeader(fresh))
	claims, err := pbsecurity.ParseUnverifiedJWT(fresh)
	if err != nil {
		t.Fatal(err)
	}
	claims[claimAuthTime] = time.Now().Add(-6 * time.Minute).Unix()
	col := passkey.Collection()
	stale, err := pbsecurity.NewJWT(claims, passkey.TokenKey()+col.AuthToken.Secret, col.AuthToken.DurationTime())
	if err != nil {
		t.Fatal(err)
	}

	for name, tok := range map[string]string{
		"session token":           session,
		"refreshed sign-in":       refreshed,
		"sign-in 6 minutes ago":   stale,
		"OIDC-only session token": oidcSession,
	} {
		rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(tok))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: delete = %d, want 403: %s", name, rec.Code, body)
		}
	}
	for _, id := range []string{passkey.Id, oidcOnly.Id} {
		if _, err := app.FindRecordById("accounts", id); err != nil {
			t.Errorf("account %s gone after a refused delete: %v", id, err)
		}
	}

	// An OIDC sign-in is as fresh as a passkey one.
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(signIn(t, mux, oidcOnly.Id)))
	if rec.Code != http.StatusOK {
		t.Fatalf("OIDC-only fresh delete = %d, want 200: %s", rec.Code, body)
	}
	// The header is read as PocketBase reads it: any case of "Bearer ".
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", map[string]string{"Authorization": "bearer " + fresh})
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh delete with a lowercase bearer = %d, want 200: %s", rec.Code, body)
	}
}

// TestDeleteAccountWithoutALogin ([D-309]): an account with neither a passkey
// nor an OIDC login, as every demo account is ([D-234]), has nothing to sign
// in with again, so its session token deletes it.
func TestDeleteAccountWithoutALogin(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Guest", "")

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete = %d, want 200: %s", rec.Code, body)
	}
	if r, err := app.FindRecordById("accounts", acct.Id); err == nil && r != nil {
		t.Errorf("account %q still exists", acct.Id)
	}
}

// TestDeleteAccountStrandedBySwitchedOffLogins ([D-309], [D-76]): a login
// the instance switched off opens nothing, so an account whose only logins
// are off cannot sign in again and its session token deletes it.
func TestDeleteAccountStrandedBySwitchedOffLogins(t *testing.T) {
	for name, passkeysOn := range map[string]bool{"passkeys off": false, "OIDC off": true} {
		app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
			RegisterRoutes(r, Options{Passkeys: passkeysOn})
		})
		Register(app, Options{Passkeys: passkeysOn})
		setOidc(t, app, !passkeysOn)
		acct, tok := createAccount(t, app, "Stranded", "")
		if passkeysOn {
			addOidcLogin(t, app, acct.Id, "sub-stranded", "")
		} else {
			testutil.CreateCredential(t, app, acct.Id)
		}

		rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: delete = %d, want 200: %s", name, rec.Code, body)
		}
	}
}

// TestSignInTokenIsPocketBases ([D-309]): the stamped token still opens the
// account, and auth-refresh mints one without the sign-in time.
func TestSignInTokenIsPocketBases(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, _ := createAccount(t, app, "Anna", "")
	fresh := signIn(t, mux, acct.Id)
	if got, err := app.FindAuthRecordByToken(fresh, core.TokenTypeAuth); err != nil || got.Id != acct.Id {
		t.Fatalf("stamped token: %v %v", got, err)
	}
	claims, _ := pbsecurity.ParseUnverifiedJWT(fresh)
	if _, ok := claims[claimAuthTime]; !ok {
		t.Errorf("sign-in token has no %s: %v", claimAuthTime, claims)
	}
	refreshed := authToken(t, mux, "/api/collections/accounts/auth-refresh", "", testutil.AuthHeader(fresh))
	claims, _ = pbsecurity.ParseUnverifiedJWT(refreshed)
	if _, ok := claims[claimAuthTime]; ok {
		t.Errorf("refreshed token carries %s: %v", claimAuthTime, claims)
	}
}

// TestDeleteAccountUnauthenticated: an unauthenticated call is rejected with
// 401 and deletes nothing.
func TestDeleteAccountUnauthenticated(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, _ := createAccount(t, app, "Alice", "")
	testutil.CreateCredential(t, app, acct.Id)

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/delete", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated delete status = %d, want 401: %s", rec.Code, body)
	}
	if r, err := app.FindRecordById("accounts", acct.Id); err != nil || r == nil {
		t.Errorf("account should still exist: err=%v rec=%v", err, r)
	}
	if n := testutil.Count(t, app, "credentials", dbx.HashExp{"account": acct.Id}); n != 1 {
		t.Errorf("credentials remaining = %d, want 1 (untouched)", n)
	}
}

// TestDeleteAccountFailureKeepsTheAccount (§4.5): the teardown is one
// transaction with the §7.3 cascades inside, so a cascade that fails leaves
// the account, its credential and every membership as they were.
func TestDeleteAccountFailureKeepsTheAccount(t *testing.T) {
	app, _ := setupDeleteApp(t)
	acct, _ := createAccount(t, app, "Alice", "")
	cred := testutil.CreateCredential(t, app, acct.Id)
	shared := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, acct.Id, shared)
	bob, _ := createAccount(t, app, "Bob", "")
	testutil.AddMembership(t, app, bob.Id, shared)
	testutil.AddMembership(t, app, acct.Id, testutil.CreateList(t, app, ""))
	if _, err := app.DB().NewQuery(
		"CREATE TRIGGER refuse_list_delete BEFORE DELETE ON lists BEGIN SELECT RAISE(ABORT, 'refused'); END",
	).Execute(); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	if err := DeleteAccount(t.Context(), app, acct); err == nil {
		t.Fatal("DeleteAccount: want the cascade's error, got nil")
	}

	if n := testutil.Count(t, app, "memberships", dbx.HashExp{"account": acct.Id}); n != 2 {
		t.Errorf("memberships = %d, want 2 (the shared leave rolled back too)", n)
	}
	if _, err := app.FindRecordById("credentials", cred.Id); err != nil {
		t.Errorf("credential gone after a failed teardown: %v", err)
	}
	if _, err := app.FindRecordById("accounts", acct.Id); err != nil {
		t.Errorf("account gone after a failed teardown: %v", err)
	}
}
