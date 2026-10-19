package oidc

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/dextest"
	"shoppinglist/internal/testutil"
)

// End-to-end coverage for the server half of the §5.9 [D-76] OIDC login,
// against a real issuer: Dex, the pinned provider in tools/dex, started per
// test by internal/dextest ([D-154]). PocketBase's SSRF guard only covers
// avatar downloads — the token/userinfo fetches use the plain oauth2 client,
// so loopback works. The browser-only hop (Dex's redirect to
// /api/oauth2-redirect and the @oauth2 SSE push back to the SDK) is bypassed
// by POSTing the exchange directly with the code — exactly what the SDK sends
// after receiving the push; `state` is not part of that exchange. The browser
// half is e2e/oidc's.

// redirectURI is what the tests tell Dex the app lives at. Only the exchange
// reads it back (Dex requires the token request to repeat it), so no server
// needs to listen there.
const redirectURI = "http://127.0.0.1/api/oauth2-redirect"

var (
	anna = dextest.User{Email: "anna@example.com", Name: "Anna", ID: "anna"}
	bob  = dextest.User{Email: "bob@idp.example", Name: "Bob", ID: "bob"}
)

type authMethods struct {
	OAuth2 struct {
		Enabled   bool `json:"enabled"`
		Providers []struct {
			Name         string `json:"name"`
			AuthURL      string `json:"authURL"`
			CodeVerifier string `json:"codeVerifier"`
		} `json:"providers"`
	} `json:"oauth2"`
}

type authResponse struct {
	Token  string `json:"token"`
	Record struct {
		Id       string `json:"id"`
		Email    string `json:"email"`
		Nickname string `json:"nickname"`
		Verified bool   `json:"verified"`
		Handle   string `json:"handle"`
	} `json:"record"`
}

// login performs one full server-side login as `user` and returns the
// exchange response. The exchange goes out UNAUTHENTICATED, which is a
// signed-out browser.
func login(t *testing.T, mux http.Handler, dex *dextest.Dex, user dextest.User) authResponse {
	t.Helper()
	out, code, body := exchange(t, mux, dex, user, nil)
	if code != http.StatusOK {
		t.Fatalf("auth-with-oauth2 = %d: %s", code, body)
	}
	if out.Token == "" {
		t.Fatalf("exchange returned no token: %s", body)
	}
	return out
}

// exchange is login's engine, split out so a test can send the exchange WITH
// an Authorization header — which is what a browser mid-link does ([D-76]:
// the popup runs while the passkey session is still in the auth store) — and
// can assert on a non-200 instead of dying on it.
func exchange(
	t *testing.T, mux http.Handler, dex *dextest.Dex, user dextest.User, headers map[string]string,
) (authResponse, int, string) {
	t.Helper()

	// Step 1: what the SDK does first — fetch the provider's auth URL and
	// PKCE verifier from the public auth-methods endpoint.
	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/collections/accounts/auth-methods", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("auth-methods = %d: %s", rec.Code, body)
	}
	var methods authMethods
	if err := json.Unmarshal([]byte(body), &methods); err != nil {
		t.Fatalf("decode auth-methods: %v (%s)", err, body)
	}
	if !methods.OAuth2.Enabled {
		t.Fatalf("oauth2 not advertised: %s", body)
	}
	var authURL, verifier string
	for _, p := range methods.OAuth2.Providers {
		if p.Name == "oidc" {
			// The authURL arrives with a trailing empty "redirect_uri=" —
			// the client appends its own.
			authURL, verifier = p.AuthURL+url.QueryEscape(redirectURI), p.CodeVerifier
		}
	}
	if authURL == "" {
		t.Fatalf("no oidc provider advertised: %s", body)
	}

	// Step 2: the popup's round trip, minus the browser — Dex's login form,
	// then its redirect back carrying the code.
	back, err := dex.Login(authURL, user.Email)
	if err != nil {
		t.Fatalf("dex login as %s: %v", user.Email, err)
	}
	code := back.Query().Get("code")
	if code == "" {
		t.Fatalf("dex redirect carries no code: %s", back)
	}

	// Step 3: the exchange — the same POST the SDK makes after the SSE push.
	body = `{"provider":"oidc","code":` + quote(code) +
		`,"codeVerifier":` + quote(verifier) +
		`,"redirectURL":` + quote(redirectURI) + `}`
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/collections/accounts/auth-with-oauth2", body, headers)
	var out authResponse
	_ = json.Unmarshal([]byte(body), &out) // an error body decodes to the zero value
	return out, rec.Code, body
}

func quote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// applyDexEnv points the accounts collection at `dex`, the way an operator's
// SHOPPINGLIST_OIDC=on and SHOPPINGLIST_OIDC_* variables do at serve time —
// through the issuer, so the endpoints come from Dex's own discovery document.
func applyDexEnv(t *testing.T, app core.App, dex *dextest.Dex) {
	t.Helper()
	t.Setenv("SHOPPINGLIST_OIDC", "on")
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_ID", dextest.ClientID)
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_SECRET", dextest.ClientSecret)
	t.Setenv("SHOPPINGLIST_OIDC_ISSUER", dex.Issuer)
	t.Setenv("SHOPPINGLIST_OIDC_NAME", "Dex")
	if err := applyEnv(app); err != nil {
		t.Fatalf("Apply: %v", err)
	}
}

// setupFlowApp starts Dex with `users` and an app pointed at it.
func setupFlowApp(t *testing.T, users ...dextest.User) (*pocketbase.PocketBase, http.Handler, *dextest.Dex) {
	t.Helper()
	dex := dextest.Start(t, redirectURI, users...)
	app, mux := testutil.NewMux(t, routes, LogOAuth2Failure)
	// Production binds the auto-create hook in main.go's post-migrations
	// OnServe block; the test needs the same binding.
	Register(app)
	applyDexEnv(t, app, dex)
	return app, mux, dex
}

// TestOAuth2FlowAutoCreatesAccount pins the first-login contract ([D-76],
// §5.9): the hook pre-creates the account — so handle must be optional for
// this to work at all — carries the provider's name claim into nickname, and
// stores NO email although the provider asserted one ([D-25]).
func TestOAuth2FlowAutoCreatesAccount(t *testing.T) {
	_, mux, dex := setupFlowApp(t, anna)

	out := login(t, mux, dex, anna)

	if out.Record.Email != "" {
		t.Errorf("email = %q, want none stored ([D-25])", out.Record.Email)
	}
	if out.Record.Nickname != "Anna" {
		t.Errorf("nickname = %q, want the mapped name claim %q", out.Record.Nickname, "Anna")
	}
	if !out.Record.Verified {
		// PocketBase unlinks an unverified record's external auths on login.
		t.Error("account not marked verified")
	}
	if out.Record.Handle != "" {
		t.Errorf("handle = %q, want empty — an OIDC-born account has none (§6.1)", out.Record.Handle)
	}
	if out.Record.Id == "" {
		t.Error("record id empty")
	}
}

// TestOAuth2FlowRelinksSameIdentity: a second login with the same provider
// subject must land on the SAME account (the ExternalAuth row is the join),
// not mint a fresh one per login.
func TestOAuth2FlowRelinksSameIdentity(t *testing.T) {
	_, mux, dex := setupFlowApp(t, anna)

	first := login(t, mux, dex, anna)
	second := login(t, mux, dex, anna)

	if first.Record.Id != second.Record.Id {
		t.Errorf("same sub produced two accounts: %s then %s", first.Record.Id, second.Record.Id)
	}
	// PocketBase copies the provider email onto an existing account whose
	// email is empty; the hook clears it first on every login, not just the
	// first ([D-25]).
	if second.Record.Email != "" {
		t.Errorf("re-login stored the provider email %q", second.Record.Email)
	}
}

// TestOAuth2FlowFailureLeavesNoAccount ([D-25]): the pre-created account and
// PocketBase's ExternalAuth row commit together. With no email stored, an
// orphan left by a failure in between could never be recognised by a retry, so
// it must not exist at all.
func TestOAuth2FlowFailureLeavesNoAccount(t *testing.T) {
	app, mux, dex := setupFlowApp(t, anna)

	fail := true
	app.OnModelCreate(core.CollectionNameExternalAuths).BindFunc(func(e *core.ModelEvent) error {
		if fail {
			return errors.New("injected failure")
		}
		return e.Next()
	})

	if _, code, body := exchange(t, mux, dex, anna, nil); code == http.StatusOK {
		t.Fatalf("exchange succeeded despite the injected failure: %s", body)
	}
	if n, _ := app.CountRecords("accounts"); n != 0 {
		t.Fatalf("failed login left %d account rows behind", n)
	}
	if n, _ := app.CountRecords("oidc_identities"); n != 0 {
		t.Fatalf("failed login left %d identity labels behind", n)
	}

	fail = false
	out := login(t, mux, dex, anna)
	if n, _ := app.CountRecords("accounts"); n != 1 {
		t.Errorf("retry left %d account rows, want exactly the one it signed into (%s)", n, out.Record.Id)
	}
}

// TestMethodsReportOwnOidcLogin ([D-25]): settings gates "Link with
// ‹provider›" on this flag, since the record carries no email to tell an OIDC
// account from a passkey one.
func TestMethodsReportOwnOidcLogin(t *testing.T) {
	app, mux, dex := setupFlowApp(t, anna)

	oidcTok := login(t, mux, dex, anna).Token
	_, passkeyTok := testutil.CreateAccount(t, app, "Bea")

	for _, tc := range []struct {
		name    string
		headers map[string]string
		want    bool
	}{
		{"signed out", nil, false},
		{"passkey account", testutil.AuthHeader(passkeyTok), false},
		{"OIDC account", testutil.AuthHeader(oidcTok), true},
	} {
		if got := getMethods(t, mux, tc.headers).Oidc; got.Linked != tc.want {
			t.Errorf("%s: linked = %v, want %v", tc.name, got.Linked, tc.want)
		}
	}
}

// TestOAuth2FlowSeparatesIdentities: distinct provider subjects are distinct
// accounts ([D-76]).
//
// Note what this does NOT cover: the two subjects carry DIFFERENT emails, so
// PocketBase's email-matching fallback never even fires and the case cannot
// fail here. The claim "no email-based merging" is pinned by
// TestOidcNeverLandsOnAnAccountByEmail (oauth2_link_test.go), where an
// account already holds the address.
func TestOAuth2FlowSeparatesIdentities(t *testing.T) {
	_, mux, dex := setupFlowApp(t, anna, bob)

	annaAuth := login(t, mux, dex, anna)
	bobAuth := login(t, mux, dex, bob)

	if annaAuth.Record.Id == bobAuth.Record.Id {
		t.Error("distinct subs merged into one account — no email auto-merge is the contract")
	}
	if bobAuth.Record.Nickname != "Bob" {
		t.Errorf("second identity not carried: %+v", bobAuth.Record)
	}
}

// TestOAuth2ExchangeFailureIsLoggedWithItsCause ([D-209]): a misconfigured
// instance fails AFTER the provider accepted the user, and PocketBase answers
// only "Failed to fetch OAuth2 token." — the cause has to reach the server log,
// with what to check, since only the operator can fix it.
func TestOAuth2ExchangeFailureIsLoggedWithItsCause(t *testing.T) {
	app, mux, dex := setupFlowApp(t, anna)
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_SECRET", "not-the-secret")
	if err := applyEnv(app); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	logged := testutil.CaptureLog(t)

	if _, code, body := exchange(t, mux, dex, anna, nil); code != http.StatusBadRequest {
		t.Fatalf("exchange with a wrong secret = %d, want 400: %s", code, body)
	}
	got := logged.String()
	for _, want := range []string{"WARNING OIDC sign-in failed", `error="Failed to fetch OAuth2 token."`,
		`cause="token endpoint answered 401 Unauthorized, invalid_client"`, `check="the client secret`, "/api/oauth2-redirect"} {
		if !strings.Contains(got, want) {
			t.Errorf("log %q lacks %q", got, want)
		}
	}
	// Only the status and the code: a provider's own text can echo the request.
	if strings.Contains(got, "error_description") || strings.Contains(got, "Invalid client credentials") {
		t.Errorf("log %q carries the provider's text", got)
	}
}
