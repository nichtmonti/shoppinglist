package webauthn

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/invites"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/signup"
	"shoppinglist/internal/testutil"
)

// Whole §5.4 ceremonies through the four routes, signed by a software
// authenticator (testutil.Authenticator), so the finish handlers' real work is
// under test: go-webauthn's verification as configured here, what a finish
// persists, and the token it mints. The browser suites drive the same
// ceremonies through Chromium's virtual authenticator; these say which check
// broke, and cover the refusals a browser cannot be made to send.

const testOrigin = "https://localhost" // FromEnv's default for RP-ID localhost

type authResponse struct {
	Token  string `json:"token"`
	Record struct {
		ID       string `json:"id"`
		Nickname string `json:"nickname"`
	} `json:"record"`
}

func browser(id string) map[string]string { return map[string]string{"X-Browser-Id": id} }

func withAuth(tok string, h map[string]string) map[string]string {
	h["Authorization"] = "Bearer " + tok
	return h
}

// register runs register/begin and register/finish for a new account, and
// returns the finish's status and body.
func register(t *testing.T, mux http.Handler, a *testutil.Authenticator, beginBody, browserID string) (int, string) {
	t.Helper()
	rec, begin := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin", beginBody, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin = %d: %s", rec.Code, begin)
	}
	fin, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", a.Register(t, begin), browser(browserID))
	return fin.Code, body
}

// loginBegin starts a discoverable login for browserID and returns its options.
func beginLogin(t *testing.T, mux http.Handler, browserID string) string {
	t.Helper()
	rec, begin := testutil.DoReq(mux, http.MethodPost, "/api/passkey/login/begin", `{"browser_id":"`+browserID+`"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login/begin = %d: %s", rec.Code, begin)
	}
	return begin
}

func finishLogin(mux http.Handler, assertion, browserID string) (int, string) {
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/login/finish", assertion, browser(browserID))
	return rec.Code, body
}

// tokenOwner is the account a minted token authenticates, or "" if it does not.
func tokenOwner(app core.App, body string) string {
	var out authResponse
	if json.Unmarshal([]byte(body), &out) != nil || out.Token == "" {
		return ""
	}
	rec, err := app.FindAuthRecordByToken(out.Token, core.TokenTypeAuth)
	if err != nil {
		return ""
	}
	return rec.Id
}

// TestPasskeyRegistersAndSignsIn: a new account's ceremony saves the account
// and its passkey and signs it in, and the same passkey then signs in to the
// same account, with a token that authenticates as it.
func TestPasskeyRegistersAndSignsIn(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)

	code, body := register(t, mux, a, `{"browser_id":"phone","nickname":"Anna"}`, "phone")
	if code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}
	accountID := tokenOwner(app, body)
	if accountID == "" || accountID != string(a.UserHandle) {
		t.Fatalf("registration token owner = %q, want the account the ceremony named (%q)", accountID, a.UserHandle)
	}
	acct, err := app.FindRecordById("accounts", accountID)
	if err != nil {
		t.Fatalf("account not saved: %v", err)
	}
	if acct.GetString("nickname") != "Anna" || acct.GetString("handle") == "" {
		t.Errorf("account = nickname %q handle %q, want Anna and a handle", acct.GetString("nickname"), acct.GetString("handle"))
	}
	cred, err := app.FindFirstRecordByData("credentials", "credential_id", base64.RawURLEncoding.EncodeToString(a.CredentialID))
	if err != nil {
		t.Fatalf("credential not saved: %v", err)
	}
	if cred.GetString("account") != accountID || cred.GetString("user_handle") != accountID {
		t.Errorf("credential account %q user_handle %q, want both %q", cred.GetString("account"), cred.GetString("user_handle"), accountID)
	}

	code, body = finishLogin(mux, a.Assert(t, beginLogin(t, mux, "laptop")), "laptop")
	if code != http.StatusOK {
		t.Fatalf("login/finish = %d: %s", code, body)
	}
	if got := tokenOwner(app, body); got != accountID {
		t.Errorf("login token owner = %q, want %q", got, accountID)
	}
}

// TestRemovedPasskeyIsNamed: a passkey the device still holds but the server
// no longer has (removed in settings, or its account deleted) answers 404,
// not the 400 of a failed verification, so the client can say so ([D-293]).
func TestRemovedPasskeyIsNamed(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	if code, body := register(t, mux, a, `{"browser_id":"phone","nickname":"Anna"}`, "phone"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}
	cred, err := app.FindFirstRecordByData("credentials", "credential_id", base64.RawURLEncoding.EncodeToString(a.CredentialID))
	if err != nil {
		t.Fatalf("credential not saved: %v", err)
	}
	if err := app.UnsafeWithoutHooks().Delete(cred); err != nil {
		t.Fatalf("delete credential: %v", err)
	}

	code, body := finishLogin(mux, a.Assert(t, beginLogin(t, mux, "phone")), "phone")
	if code != http.StatusNotFound || tokenOwner(app, body) != "" {
		t.Errorf("login/finish with a removed passkey = %d: %s, want 404 and no token", code, body)
	}
}

// TestCredentialLookupFailureKeepsThePasskey: a credentials lookup the
// database fails answers 500, not the 404 on which the client asks the
// browser to forget a working passkey ([D-191]).
func TestCredentialLookupFailureKeepsThePasskey(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	if code, body := register(t, mux, a, `{"browser_id":"phone","nickname":"Anna"}`, "phone"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}
	assertion := a.Assert(t, beginLogin(t, mux, "phone"))
	if _, err := app.DB().NewQuery("DROP TABLE credentials").Execute(); err != nil {
		t.Fatalf("drop credentials: %v", err)
	}

	if code, body := finishLogin(mux, assertion, "phone"); code != http.StatusInternalServerError {
		t.Errorf("login/finish with the credentials lookup failing = %d: %s, want 500", code, body)
	}
}

// TestExpiredSessionRefusesAValidCeremony: a session past its ~5-minute TTL
// (§5.5) refuses a finish the authenticator signed correctly, at register and
// at login, and writes nothing. A correct signature leaves the expiry as the
// only reason to refuse: an empty body would be refused without it.
func TestExpiredSessionRefusesAValidCeremony(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	expire := func(browserID string) { expireSession(t, app, browserID) }

	rec, begin := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin", `{"browser_id":"late","nickname":"Anna"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin = %d: %s", rec.Code, begin)
	}
	expire("late")
	fin, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", a.Register(t, begin), browser("late"))
	if fin.Code != http.StatusBadRequest || !strings.Contains(body, "expired") {
		t.Errorf("register/finish on an expired session = %d: %s, want 400 session expired", fin.Code, body)
	}
	if n, _ := app.CountRecords("accounts"); n != 0 {
		t.Errorf("accounts after an expired register = %d, want 0", n)
	}

	if code, body := register(t, mux, a, `{"browser_id":"phone","nickname":"Anna"}`, "phone"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}
	begin = beginLogin(t, mux, "laptop")
	expire("laptop")
	code, body := finishLogin(mux, a.Assert(t, begin), "laptop")
	if code != http.StatusBadRequest || !strings.Contains(body, "expired") || tokenOwner(app, body) != "" {
		t.Errorf("login/finish on an expired session = %d: %s, want 400 session expired and no token", code, body)
	}
}

// TestLoginRefusesWhatTheKeyDidNotSign: each thing the signature binds is
// checked. An assertion for one challenge does not finish another login, a
// page on another origin cannot use the passkey (phishing), and a passkey's id
// with someone else's key does not sign in as it.
func TestLoginRefusesWhatTheKeyDidNotSign(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	if code, body := register(t, mux, a, `{"browser_id":"reg"}`, "reg"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}

	t.Run("an assertion for an earlier challenge", func(t *testing.T) {
		old := a.Assert(t, beginLogin(t, mux, "b1"))
		beginLogin(t, mux, "b2")
		if code, body := finishLogin(mux, old, "b2"); code != http.StatusBadRequest || tokenOwner(app, body) != "" {
			t.Errorf("finish with another session's assertion = %d %s, want 400", code, body)
		}
	})

	t.Run("another origin", func(t *testing.T) {
		phish := *a
		phish.Origin = "https://localhost.evil.example"
		if code, body := finishLogin(mux, phish.Assert(t, beginLogin(t, mux, "b3")), "b3"); code != http.StatusBadRequest {
			t.Errorf("finish from another origin = %d %s, want 400", code, body)
		}
	})

	t.Run("another RP-ID", func(t *testing.T) {
		other := *a
		other.RPID = "evil.example"
		if code, body := finishLogin(mux, other.Assert(t, beginLogin(t, mux, "b4")), "b4"); code != http.StatusBadRequest {
			t.Errorf("finish for another RP-ID = %d %s, want 400", code, body)
		}
	})

	t.Run("the passkey's id with another key", func(t *testing.T) {
		forger := testutil.NewAuthenticator(t, "localhost", testOrigin)
		forger.CredentialID, forger.UserHandle = a.CredentialID, a.UserHandle
		if code, body := finishLogin(mux, forger.Assert(t, beginLogin(t, mux, "b5")), "b5"); code != http.StatusBadRequest {
			t.Errorf("finish signed by another key = %d %s, want 400", code, body)
		}
	})

	t.Run("an unknown passkey", func(t *testing.T) {
		stranger := testutil.NewAuthenticator(t, "localhost", testOrigin)
		stranger.UserHandle = a.UserHandle
		// 404, so the client can tell the user ([D-293]); never a token.
		if code, body := finishLogin(mux, stranger.Assert(t, beginLogin(t, mux, "b6")), "b6"); code != http.StatusNotFound || tokenOwner(app, body) != "" {
			t.Errorf("finish with an unregistered passkey = %d %s, want 404 and no token", code, body)
		}
	})

	// The control: the refusals above are the checks, not a broken harness.
	if code, body := finishLogin(mux, a.Assert(t, beginLogin(t, mux, "b7")), "b7"); code != http.StatusOK {
		t.Errorf("the genuine assertion = %d %s, want 200", code, body)
	}
}

// TestReplayedLoginFinishRejected: login/finish consumes its session
// (single-use, §5.5), so the same correctly signed assertion sent again finds
// no session and mints no second token. The signature verifies and the counter
// is advisory, so the consumed session is the only thing that can refuse it.
func TestReplayedLoginFinishRejected(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	if code, body := register(t, mux, a, `{"browser_id":"reg"}`, "reg"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}

	assertion := a.Assert(t, beginLogin(t, mux, "laptop"))
	if code, body := finishLogin(mux, assertion, "laptop"); code != http.StatusOK || tokenOwner(app, body) == "" {
		t.Fatalf("first login/finish = %d %s, want 200 and a token", code, body)
	}
	code, body := finishLogin(mux, assertion, "laptop")
	if code != http.StatusBadRequest || !strings.Contains(body, "Session not found or expired") || tokenOwner(app, body) != "" {
		t.Errorf("replayed login/finish = %d %s, want 400 for the consumed session and no token", code, body)
	}
}

// TestSignCounterIsAdvisory: a counter that does not advance is logged as a
// possible clone and never refused, since most platform authenticators send 0
// every time and a refused passkey cannot be re-issued (handlers.go,
// updateCredential).
func TestSignCounterIsAdvisory(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	if code, body := register(t, mux, a, `{"browser_id":"reg"}`, "reg"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}
	logs := testutil.CaptureLog(t)

	for i := range 2 { // always 0, as iCloud Keychain sends it
		if code, body := finishLogin(mux, a.Assert(t, beginLogin(t, mux, "zero")), "zero"); code != http.StatusOK {
			t.Fatalf("login %d with a zero counter = %d %s", i, code, body)
		}
	}
	if strings.Contains(logs.String(), "cloned") {
		t.Errorf("a counter that is always 0 was flagged: %s", logs)
	}

	a.Count = 7
	if code, body := finishLogin(mux, a.Assert(t, beginLogin(t, mux, "up")), "up"); code != http.StatusOK {
		t.Fatalf("login with counter 7 = %d %s", code, body)
	}
	a.Count = 3
	if code, body := finishLogin(mux, a.Assert(t, beginLogin(t, mux, "down")), "down"); code != http.StatusOK || tokenOwner(app, body) == "" {
		t.Fatalf("login with a counter gone back = %d %s, want 200: the signal is advisory", code, body)
	}
	if !strings.Contains(logs.String(), "may be cloned") {
		t.Errorf("a counter gone back was not logged: %q", logs)
	}
}

// TestAddPasskeyOnlyForTheSessionsAccount: adding a passkey runs on the
// account signed in at begin. A finish by anyone else, signed in or not, with
// that browser id attaches nothing and leaves the session alone (§5.5); the
// account's own finish then adds a passkey that signs in to it.
func TestAddPasskeyOnlyForTheSessionsAccount(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	anna, annaTok := testutil.CreateAccount(t, app, "Anna")
	_, malloryTok := testutil.CreateAccount(t, app, "Mallory")

	rec, begin := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"anna-tablet","friendly_name":"Tablet"}`, testutil.AuthHeader(annaTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin = %d: %s", rec.Code, begin)
	}

	att := testutil.NewAuthenticator(t, "localhost", testOrigin).Register(t, begin)
	for name, h := range map[string]map[string]string{
		"signed in as someone else": withAuth(malloryTok, browser("anna-tablet")),
		"not signed in":             browser("anna-tablet"),
	} {
		if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", att, h); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: finish = %d %s, want 400", name, rec.Code, body)
		}
	}
	if n, _ := app.CountRecords("credentials"); n != 0 {
		t.Fatalf("credentials = %d after refused finishes, want 0", n)
	}

	annasKey := testutil.NewAuthenticator(t, "localhost", testOrigin)
	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", annasKey.Register(t, begin), withAuth(annaTok, browser("anna-tablet"))); rec.Code != http.StatusOK {
		t.Fatalf("Anna's finish after the refused ones = %d %s, want 200: they must not consume her session", rec.Code, body)
	}
	cred, err := app.FindFirstRecordByData("credentials", "credential_id", base64.RawURLEncoding.EncodeToString(annasKey.CredentialID))
	if err != nil || cred.GetString("account") != anna || cred.GetString("friendly_name") != "Tablet" {
		t.Fatalf("added passkey = %v %v, want Anna's, named Tablet", cred, err)
	}
	if code, body := finishLogin(mux, annasKey.Assert(t, beginLogin(t, mux, "later")), "later"); tokenOwner(app, body) != anna {
		t.Errorf("the added passkey signs in as %q (%d %s), want Anna", tokenOwner(app, body), code, body)
	}
}

// TestInviteSignupIsCheckedAgainAtFinish ([D-241]): under
// SHOPPINGLIST_SIGNUP=invite the link is checked at begin and again at finish,
// so a link revoked mid-ceremony creates nothing, and a live one creates the
// account already on the link's list.
func TestInviteSignupIsCheckedAgainAtFinish(t *testing.T) {
	app, mux := setupWebauthnAppWithSignup(t, signup.NewGate(signup.Invite))
	owner, _ := testutil.CreateAccount(t, app, "Anna")
	listID := testutil.CreateListFor(t, app, owner, "Wocheneinkauf")
	mint := func(token string) {
		col, _ := app.FindCollectionByNameOrId("invites")
		inv := core.NewRecord(col)
		inv.Set("list", listID)
		inv.Set("created_by", owner)
		h, _ := randid.LookupHash(token)
		inv.Set("token_hash", h)
		inv.Set("expires_at", types.NowDateTime().Add(time.Hour))
		if err := app.SaveNoValidate(inv); err != nil {
			t.Fatal(err)
		}
	}

	mint("first-link")
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	rec, begin := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"bob","nickname":"Bob","invite":"first-link"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("begin with a live link = %d: %s", rec.Code, begin)
	}
	if _, err := invites.RevokeLive(app, listID); err != nil {
		t.Fatal(err)
	}
	fin, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", a.Register(t, begin), browser("bob"))
	if fin.Code != http.StatusForbidden {
		t.Errorf("finish after the link was revoked = %d %s, want 403", fin.Code, body)
	}
	if n, _ := app.CountRecords("accounts"); n != 1 {
		t.Errorf("accounts = %d after a refused finish, want only Anna's", n)
	}
	if n, _ := app.CountRecords("credentials"); n != 0 {
		t.Errorf("credentials = %d after a refused finish, want 0", n)
	}

	mint("second-link")
	code, body := register(t, mux, a, `{"browser_id":"bob","nickname":"Bob","invite":"second-link"}`, "bob")
	if code != http.StatusOK {
		t.Fatalf("finish with a live link = %d: %s", code, body)
	}
	bob := tokenOwner(app, body)
	if m, _ := app.FindFirstRecordByFilter("memberships", "account = {:a} && list = {:l}",
		map[string]any{"a": bob, "l": listID}); bob == "" || m == nil {
		t.Errorf("the account the link created (%q) is not on its list", bob)
	}
}

// TestRefusedCeremonySaysOnlyThatItFailed: a ceremony go-webauthn refuses is
// answered with a fixed message, and which check failed (here the origin, with
// the value the server expected) goes to the server log only: told to an
// unauthenticated caller, it helps tune a phishing relay.
func TestRefusedCeremonySaysOnlyThatItFailed(t *testing.T) {
	_, mux := setupWebauthnApp(t)
	a := testutil.NewAuthenticator(t, "localhost", testOrigin)
	phish := *a
	phish.Origin = "https://localhost.evil.example"
	logs := testutil.CaptureLog(t)

	rec, begin := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin", `{"browser_id":"p1","nickname":"Anna"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin = %d: %s", rec.Code, begin)
	}
	fin, regBody := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", phish.Register(t, begin), browser("p1"))
	if code, body := register(t, mux, a, `{"browser_id":"reg"}`, "reg"); code != http.StatusOK {
		t.Fatalf("register/finish = %d: %s", code, body)
	}
	phish = *a // now with the registered passkey
	phish.Origin = "https://localhost.evil.example"
	code, loginBody := finishLogin(mux, phish.Assert(t, beginLogin(t, mux, "p2")), "p2")

	for _, tc := range []struct {
		ceremony, body, want string
		code                 int
	}{
		{"register", regBody, "Registration verification failed.", fin.Code},
		{"login", loginBody, "Login verification failed.", code},
	} {
		var got struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal([]byte(tc.body), &got)
		if tc.code != http.StatusBadRequest || got.Message != tc.want {
			t.Errorf("%s from another origin = %d %q, want 400 %q", tc.ceremony, tc.code, got.Message, tc.want)
		}
		if strings.Contains(tc.body, "evil") || strings.Contains(tc.body, testOrigin) {
			t.Errorf("%s answer names the origins: %s", tc.ceremony, tc.body)
		}
	}
	for _, ceremony := range []string{"registration", "login"} {
		if !strings.Contains(logs.String(), "passkey "+ceremony+" refused\" reason=\"Error validating origin :: Expected Values: [https://localhost], Received: https://localhost.evil.example") {
			t.Errorf("the server log lacks the %s's refused origin: %q", ceremony, logs.String())
		}
	}
}
