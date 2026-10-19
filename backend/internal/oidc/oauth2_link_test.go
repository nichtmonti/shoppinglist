package oidc

import (
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/account"
	"shoppinglist/internal/dextest"
	"shoppinglist/internal/lists"
	"shoppinglist/internal/testutil"
)

// End-to-end coverage for the §5.9 [D-76] passkey→OIDC LINK, driven through
// Dex rather than through hand-minted tokens.
//
// internal/account/link_test.go already pins what the link attaches and when
// it refuses, but it starts from two tokens it made itself. That skips the
// half that once broke: the browser reaches POST /api/account/link only after the
// OAuth2 popup, and it runs that popup while STILL SIGNED IN as the passkey
// account — so the exchange carries an Authorization header. PocketBase's
// oauth2Submit treats that header as a fallback identity and aimed the
// provider subject at the passkey account, which the §11 accounts guard then
// refused ("Field \"email\" cannot be changed directly", 403). The link could
// never complete, and no test looked, because the component test mocks
// linkOidc and link_test.go never performs an exchange.
//
// internal/oidc/hooks.go now asserts the ExternalAuth row before accepting the
// record PocketBase resolved. These tests hold that: one full happy path, the
// refusal of a subject whose account is in use, and one regression per
// fallback PocketBase would otherwise take.

// setupLinkApp mounts BOTH route sets on one app — the OIDC status probe and
// PocketBase's own auth API from this package, the account lifecycle routes
// from internal/account — plus every hook main.go binds for them: the OIDC
// identity gate, the §11 accounts allowlist and the §7.3 membership cascade.
func setupLinkApp(t *testing.T, users ...dextest.User) (*pocketbase.PocketBase, http.Handler, *dextest.Dex) {
	t.Helper()
	dex := dextest.Start(t, redirectURI, users...)
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		routes(r)
		account.RegisterRoutes(r, account.Options{Passkeys: true})
	})
	Register(app)
	account.Register(app, account.Options{Passkeys: true})
	lists.Register(app)
	applyDexEnv(t, app, dex)
	return app, mux, dex
}

// TestLinkFlowEndToEnd walks the whole §5.9 [D-76] link exactly as the browser
// does it: passkey session in hand, popup exchange against the issuer (which
// creates an empty account for the new subject), then POST /api/account/link
// carrying BOTH sessions. The OIDC login must end up on the passkey account,
// which keeps its id, lists and passkeys; the empty account must be gone; and
// the next provider sign-in must land in the passkey account.
func TestLinkFlowEndToEnd(t *testing.T) {
	app, mux, dex := setupLinkApp(t, anna)

	passkeyID, passkeyTok := testutil.CreateAccount(t, app, "Anna")
	credID := testutil.CreateCredential(t, app, passkeyID).Id
	solo := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, passkeyID, solo)
	shared := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, passkeyID, shared)
	housemateID, _ := testutil.CreateAccount(t, app, "Bea")
	testutil.AddMembership(t, app, housemateID, shared)

	// The popup, with the passkey session still on the client — the request
	// PocketBase would aim at the passkey account without the hook.
	oidcAuth, code, body := exchange(t, mux, dex, anna, testutil.AuthHeader(passkeyTok))
	if code != http.StatusOK {
		t.Fatalf("OIDC exchange while signed in as the passkey account = %d: %s", code, body)
	}
	if oidcAuth.Record.Id == passkeyID {
		t.Fatalf("provider subject was attached to the passkey account %s instead of its own", passkeyID)
	}
	oidcID := oidcAuth.Record.Id

	// The link itself: A's session in the header, B's fresh token in the body.
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/link",
		`{"token":"`+oidcAuth.Token+`"}`, testutil.AuthHeader(passkeyTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("link = %d, want 200: %s", rec.Code, body)
	}

	if _, err := app.FindRecordById("accounts", passkeyID); err != nil {
		t.Fatalf("passkey account gone after the link: %v", err)
	}
	if _, err := app.FindRecordById("accounts", oidcID); err == nil {
		t.Error("the empty OIDC account survived the link")
	}
	for _, listID := range []string{solo, shared} {
		n, _ := app.CountRecords("memberships", dbx.HashExp{"account": passkeyID, "list": listID})
		if n != 1 {
			t.Errorf("passkey account has %d memberships for list %s, want 1", n, listID)
		}
	}
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"list": shared}); n != 2 {
		t.Errorf("shared list has %d members after the link, want 2", n)
	}
	cred, err := app.FindRecordById("credentials", credID)
	if err != nil || cred.GetString("account") != passkeyID {
		t.Errorf("passkey moved or gone in the link (err %v)", err)
	}
	// Every session of the passkey account stays valid — the other devices
	// signed in as it keep working.
	if got, err := app.FindAuthRecordByToken(passkeyTok, core.TokenTypeAuth); err != nil || got.Id != passkeyID {
		t.Errorf("passkey session no longer authenticates the passkey account (err %v)", err)
	}

	// And the provider sign-in now resolves to the passkey account.
	again := login(t, mux, dex, anna)
	if again.Record.Id != passkeyID {
		t.Errorf("re-login landed on %s, want the passkey account %s", again.Record.Id, passkeyID)
	}
}

// TestLinkFlowRefusesAnOidcAccountInUse: the provider subject already has an
// account with a list of its own. Linking it from a passkey account is refused
// (409), and both accounts stay as they were — the OIDC login stays on the
// subject's own account.
func TestLinkFlowRefusesAnOidcAccountInUse(t *testing.T) {
	app, mux, dex := setupLinkApp(t, anna)

	existing := login(t, mux, dex, anna)
	oidcID := existing.Record.Id
	oidcList := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, oidcID, oidcList)

	passkeyID, passkeyTok := testutil.CreateAccount(t, app, "Anna")
	passkeyList := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, passkeyID, passkeyList)

	oidcAuth, code, body := exchange(t, mux, dex, anna, testutil.AuthHeader(passkeyTok))
	if code != http.StatusOK {
		t.Fatalf("exchange = %d: %s", code, body)
	}
	if oidcAuth.Record.Id != oidcID {
		t.Fatalf("exchange landed on %s, want the subject's account %s", oidcAuth.Record.Id, oidcID)
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/link",
		`{"token":"`+oidcAuth.Token+`"}`, testutil.AuthHeader(passkeyTok))
	if rec.Code != http.StatusConflict {
		t.Fatalf("link = %d, want 409: %s", rec.Code, body)
	}

	for id, list := range map[string]string{passkeyID: passkeyList, oidcID: oidcList} {
		if _, err := app.FindRecordById("accounts", id); err != nil {
			t.Errorf("account %s gone after a refused link: %v", id, err)
		}
		if n, _ := app.CountRecords("memberships", dbx.HashExp{"account": id}); n != 1 {
			t.Errorf("account %s has %d memberships after a refused link, want 1", id, n)
		}
		if n, _ := app.CountRecords("memberships", dbx.HashExp{"account": id, "list": list}); n != 1 {
			t.Errorf("account %s lost its list %s", id, list)
		}
	}
	if n, _ := app.CountRecords(core.CollectionNameExternalAuths, dbx.HashExp{"recordRef": passkeyID}); n != 0 {
		t.Errorf("passkey account gained %d OIDC logins from a refused link", n)
	}
	// The subject still maps to its own account. (Read from the row rather
	// than by a third sign-in: PocketBase allows two per IP in three seconds.)
	if n, _ := app.CountRecords(core.CollectionNameExternalAuths, dbx.HashExp{"recordRef": oidcID}); n != 1 {
		t.Errorf("the subject's account has %d OIDC logins after a refused link, want 1", n)
	}
}

// TestOidcLoginNeverAttachesToTheCallersSession pins the narrow rule the link
// flow depends on: a bearer token on the exchange is NOT an identity claim.
// PocketBase would take it as one (its `fallbackAuthRecord` branch); the hook
// discards it, so the subject gets its own account and the caller's is left
// exactly as it was.
func TestOidcLoginNeverAttachesToTheCallersSession(t *testing.T) {
	app, mux, dex := setupLinkApp(t, anna)

	callerID, callerTok := testutil.CreateAccount(t, app, "Anna")

	out, code, body := exchange(t, mux, dex, anna, testutil.AuthHeader(callerTok))
	if code != http.StatusOK {
		t.Fatalf("exchange = %d: %s", code, body)
	}
	if out.Record.Id == callerID {
		t.Fatalf("Dex subject for %s authenticated as the caller's account %s", anna.Email, callerID)
	}

	caller, err := app.FindRecordById("accounts", callerID)
	if err != nil {
		t.Fatalf("caller account gone: %v", err)
	}
	if got := caller.Email(); got != "" {
		t.Errorf("caller account picked up the provider email %q", got)
	}
	n, _ := app.CountRecords(core.CollectionNameExternalAuths, dbx.HashExp{"recordRef": callerID})
	if n != 0 {
		t.Errorf("caller account gained %d external auth rows; the subject is not its identity", n)
	}
}

// TestOidcNeverLandsOnAnAccountByEmail is the [D-76] "no email-based
// merging" claim, tested where it bites: an account that holds the address
// the provider asserts. PocketBase's third fallback matches an existing
// account by email; the hook discards it, so the subject gets its own account.
//
// No account the app creates holds an email ([D-25]), so the fallback can
// only ever meet a row from before migration 1778000013 — which is exactly
// what this seeds.
func TestOidcNeverLandsOnAnAccountByEmail(t *testing.T) {
	app, mux, dex := setupLinkApp(t, anna)

	legacyID, _ := testutil.CreateAccount(t, app, "Legacy")
	// Raw SQL, as the row sat on disk: the §11 guard refuses this write on
	// every record path, which is the point of it.
	if _, err := app.DB().NewQuery("UPDATE accounts SET email = {:e}, verified = TRUE WHERE id = {:id}").
		Bind(dbx.Params{"e": anna.Email, "id": legacyID}).Execute(); err != nil {
		t.Fatalf("give the legacy account the address: %v", err)
	}

	out := login(t, mux, dex, anna)
	if out.Record.Id == legacyID {
		t.Fatalf("TAKEOVER: the Dex subject for %s signed into the account holding that address", anna.Email)
	}
	n, _ := app.CountRecords(core.CollectionNameExternalAuths, dbx.HashExp{"recordRef": legacyID})
	if n != 0 {
		t.Errorf("legacy account gained %d external auth rows", n)
	}
}
