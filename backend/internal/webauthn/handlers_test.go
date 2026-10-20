package webauthn

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
	"shoppinglist/internal/settings"
	"shoppinglist/internal/signup"
	"shoppinglist/internal/testutil"
)

// FromEnv reads the settings as the start does, for the tests that set them.
func FromEnv() (*Config, error) {
	s, err := settings.ReadServe()
	if err != nil {
		return nil, err
	}
	b, err := settings.ReadBoot()
	if err != nil {
		return nil, err
	}
	return FromSettings(s, b)
}

// setupWebauthnApp bootstraps a temp app with migrations + the four passkey
// routes mounted, returning the app and a dispatchable mux.
func setupWebauthnApp(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	return setupWebauthnAppWithSignup(t, signup.NewGate(signup.Open))
}

// setupWebauthnAppWithSignup is setupWebauthnApp with the SHOPPINGLIST_SIGNUP
// gate pinned explicitly, for the tests that care which side of it they are on.
func setupWebauthnAppWithSignup(t *testing.T, gate *signup.Gate) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	wa, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		RegisterRoutes(r, wa, gate)
	})
}

// TestBeginLeavesNoAccountRows (§5.4): a new-account begin that is never
// finished must leave ZERO account rows (orphan-avoidance on cancel).
func TestBeginLeavesNoAccountRows(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"cancel","nickname":"Alice"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("begin status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if n, _ := app.CountRecords("accounts"); n != 0 {
		t.Errorf("accounts after begin-without-finish = %d, want 0", n)
	}
}

// TestReplayedFinishRejected: a finish consumes the session (single-use, §5.5),
// so a replayed finish finds no session and is rejected.
func TestReplayedFinishRejected(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	if rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin", `{"browser_id":"rep"}`, nil); rec.Code != http.StatusOK {
		t.Fatalf("begin status = %d", rec.Code)
	}
	// first finish with an invalid body — session is consumed regardless
	first, _ := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", `{}`, map[string]string{"X-Browser-Id": "rep"})
	if first.Code != http.StatusBadRequest {
		t.Errorf("first finish status = %d, want 400", first.Code)
	}
	// replay — session gone
	second, _ := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/finish", `{}`, map[string]string{"X-Browser-Id": "rep"})
	if second.Code != http.StatusBadRequest {
		t.Errorf("replayed finish status = %d, want 400", second.Code)
	}
	// Attribute the replay's 400 to the consumed session, not to the invalid
	// body: an invalid body alone also yields 400, so the status alone cannot
	// tell a single-use regression apart from a normal verification failure.
	if !strings.Contains(second.Body.String(), "Session not found or expired") {
		t.Errorf("replayed finish body = %q, want the consumed-session rejection", second.Body.String())
	}
	if n, _ := app.CountRecords("accounts"); n != 0 {
		t.Errorf("accounts after failed finishes = %d, want 0", n)
	}
}

// TestRegisterBeginCapsTheNames ([D-08]): finish saves with SaveNoValidate,
// so begin's caps from the shared contract are the only bound on the nickname
// every co-member sees and on the passkey's label. One byte over is refused
// before any session is stored; exactly the cap is accepted.
func TestRegisterBeginCapsTheNames(t *testing.T) {
	for _, f := range []struct{ collection, field, json string }{
		{"accounts", "nickname", "nickname"},
		{"credentials", "friendly_name", "friendly_name"},
	} {
		t.Run(f.field, func(t *testing.T) {
			app, mux := setupWebauthnApp(t)
			max, ok := fieldcontract.MaxBytes(f.collection, f.field)
			if !ok {
				t.Fatalf("no cap for %s.%s in the contract", f.collection, f.field)
			}

			// A byte over, in fewer characters than the cap: the cap is bytes.
			over := strings.Repeat("ä", max/2) + strings.Repeat("a", max%2+1)
			if len(over) != max+1 {
				t.Fatalf("setup: %d bytes, want %d", len(over), max+1)
			}
			rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
				`{"browser_id":"over","`+f.json+`":"`+over+`"}`, nil)
			if want := fieldcontract.OverCap(f.collection, f.field, over); rec.Code != http.StatusBadRequest || !strings.Contains(strings.ToLower(body), want) {
				t.Errorf("begin with a %d-byte %s = %d %s, want 400 %q", len(over), f.field, rec.Code, body, want)
			}
			if n := sessionCount(app, ""); n != 0 {
				t.Errorf("ceremony sessions after a refused begin = %d, want 0", n)
			}

			if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
				`{"browser_id":"at","`+f.json+`":"`+strings.Repeat("a", max)+`"}`, nil); rec.Code != http.StatusOK {
				t.Errorf("begin with a %d-byte %s = %d %s, want 200", max, f.field, rec.Code, body)
			}
		})
	}
}

// TestLoginBeginPlumbing: discoverable-login begin returns 200 + an assertion.
func TestLoginBeginPlumbing(t *testing.T) {
	_, mux := setupWebauthnApp(t)
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/login/begin", `{"browser_id":"l1"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login begin status = %d: %s", rec.Code, body)
	}
	if !strings.Contains(body, "publicKey") {
		t.Errorf("login begin response missing publicKey assertion: %s", body)
	}
}

// TestFromEnvValidation (§5.7): refuse unset / raw-IP RP-IDs; accept a domain.
func TestFromEnvValidation(t *testing.T) {
	t.Setenv("SHOPPINGLIST_RP_ID", "")
	if _, err := FromEnv(); err == nil {
		t.Error("unset RP_ID should be rejected")
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "192.168.1.5")
	if _, err := FromEnv(); err == nil {
		t.Error("raw-IP RP_ID should be rejected")
	}
	// A URL where the domain belongs names the setting, not go-webauthn's field.
	for _, bad := range []string{"https://shop.example.com", "shop.example.com:8443", "shop.example.com/list"} {
		t.Setenv("SHOPPINGLIST_RP_ID", bad)
		if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "SHOPPINGLIST_RP_ID") ||
			!strings.Contains(err.Error(), "bare domain") {
			t.Errorf("RP_ID %q: error %v, want one naming the setting and a bare domain", bad, err)
		}
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "shop.example.com")
	if _, err := FromEnv(); err != nil {
		t.Errorf("domain RP_ID should be accepted: %v", err)
	}
}

// TestFromEnvOriginValidation (§5.7): an RP_ORIGIN the browser can never
// show refuses the boot, naming the setting, instead of failing every passkey.
func TestFromEnvOriginValidation(t *testing.T) {
	t.Setenv("SHOPPINGLIST_PASSKEYS", "")
	t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
	for _, origin := range []string{
		"list.example.com",                 // no scheme
		"https://",                         // no host
		"https://list.example.com/app",     // a path
		"https://list.example.com/?x=1",    // a query
		"ftp://list.example.com",           // not http(s)
		"https://other.example.com",        // RP-ID not its host or a parent
		"https://list.example.com.evil.io", // suffix without the dot boundary
		"http://list.example.com",          // plain http off localhost
	} {
		t.Setenv("SHOPPINGLIST_RP_ORIGIN", origin)
		if _, err := FromEnv(); err == nil {
			t.Errorf("RP_ORIGIN %q should be rejected", origin)
		} else if !strings.Contains(err.Error(), "SHOPPINGLIST_RP_ORIGIN") {
			t.Errorf("RP_ORIGIN %q: error does not name the setting: %v", origin, err)
		}
	}
	for origin, want := range map[string]string{
		"https://list.example.com":      "https://list.example.com",
		"https://list.example.com/":     "https://list.example.com",
		"https://LIST.example.com:8443": "https://list.example.com:8443",
		"HTTPS://list.example.com:443":  "https://list.example.com",
	} {
		t.Setenv("SHOPPINGLIST_RP_ORIGIN", origin)
		cfg, err := FromEnv()
		if err != nil {
			t.Errorf("RP_ORIGIN %q should be accepted: %v", origin, err)
		} else if cfg.RPOrigin != want {
			t.Errorf("RP_ORIGIN %q: RPOrigin = %q, want %q", origin, cfg.RPOrigin, want)
		}
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "example.com")
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "https://list.example.com")
	if _, err := FromEnv(); err != nil {
		t.Errorf("a parent-domain RP-ID should be accepted: %v", err)
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "http://localhost:5173")
	if _, err := FromEnv(); err != nil {
		t.Errorf("plain http on localhost should be accepted: %v", err)
	}

	// Passkeys off: only the shape is checked; there is no RP-ID to match.
	t.Setenv("SHOPPINGLIST_PASSKEYS", "off")
	t.Setenv("SHOPPINGLIST_RP_ID", "")
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "http://192.168.1.5:8090")
	if _, err := FromEnv(); err != nil {
		t.Errorf("passkeys off: an http IP origin should be accepted: %v", err)
	}
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "192.168.1.5:8090")
	if _, err := FromEnv(); err == nil {
		t.Error("passkeys off: an origin without a scheme should be rejected")
	}
}

// TestFinishRateLimited (§10): the finish routes are rate-limited per IP,
// independently of the begin routes. Uses a dedicated RemoteAddr (TEST-NET-3,
// 203.0.113.0/24) instead of httptest's default 192.0.2.1 so saturating this
// limiter cannot poison the shared RatePasskeyFinish/RatePasskeyBegin bucket that every
// other test in this file implicitly shares (httptest.NewRequest always sets
// RemoteAddr to 192.0.2.1).
func TestFinishRateLimited(t *testing.T) {
	_, mux := setupWebauthnApp(t)
	const ip = "203.0.113.7:1"

	finishReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/passkey/register/finish", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Browser-Id", "rl")
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	for i := range 30 {
		if rec := finishReq(); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d: rate-limited too early: %s", i+1, rec.Body.String())
		}
	}
	if rec := finishReq(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("31st finish attempt status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
}

// TestSessionCarriesFriendlyName: a friendly_name passed to createSession
// (the "add backup passkey" flow) survives a peekSession roundtrip, so
// registerFinish can read it back and pass it to persistCredential.
func TestSessionCarriesFriendlyName(t *testing.T) {
	app, _ := setupWebauthnApp(t)
	sd := &webauthn.SessionData{Challenge: "fn-test"}
	createSession(app, "bid-fn", sessionTypeRegister, sd, nil, "acct-1", "iPhone")
	s, err := peekSession(app, "bid-fn", sessionTypeRegister)
	if err != nil {
		t.Fatalf("peekSession: %v", err)
	}
	if s.FriendlyName != "iPhone" {
		t.Errorf("FriendlyName = %q, want %q", s.FriendlyName, "iPhone")
	}
}

// TestSignupClosedRefusesNewAccount: with SHOPPINGLIST_SIGNUP=closed an
// anonymous register/begin is refused and — the part that actually matters —
// leaves no account row behind.
func TestSignupClosedRefusesNewAccount(t *testing.T) {
	app, mux := setupWebauthnAppWithSignup(t, signup.NewGate(signup.Closed))
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"closed","nickname":"Mallory"}`, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("begin status = %d, want 403: %s", rec.Code, body)
	}
	if n, _ := app.CountRecords("accounts"); n != 0 {
		t.Errorf("accounts after refused begin = %d, want 0", n)
	}
}

// TestSignupClosedStillAllowsAddPasskey is the regression this whole gate has
// to survive: closing signup must not stop an EXISTING account from enrolling
// a second passkey. registerBegin branches on e.Auth, and only the anonymous
// branch is gated — see the note in frontend/src/lib/auth/passkey.ts on why these are
// two flows and not one.
func TestSignupClosedStillAllowsAddPasskey(t *testing.T) {
	app, mux := setupWebauthnAppWithSignup(t, signup.NewGate(signup.Closed))
	_, tok := testutil.CreateAccount(t, app, "Alice")
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"add","friendly_name":"iPhone"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("authenticated begin status = %d, want 200: %s", rec.Code, body)
	}
	if !strings.Contains(body, "publicKey") {
		t.Errorf("authenticated begin missing publicKey options: %s", body)
	}
}

// TestAddPasskeyWithRevokedTokenIsRefused: PocketBase ignores a token that no
// longer verifies and leaves e.Auth nil, so an "add passkey" from a device
// signed out everywhere ("Überall abmelden" rotates the key) took the signup
// branch and, on an open instance, put the new passkey on a NEW empty account
// while the user believed it backed up theirs (§4.3).
func TestAddPasskeyWithRevokedTokenIsRefused(t *testing.T) {
	app, mux := setupWebauthnAppWithSignup(t, signup.NewGate(signup.Open))
	id, tok := testutil.CreateAccount(t, app, "Alice")
	acct, err := app.FindRecordById("accounts", id)
	if err != nil {
		t.Fatal(err)
	}
	acct.RefreshTokenKey()
	if err := app.SaveNoValidate(acct); err != nil {
		t.Fatal(err)
	}
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"stale","friendly_name":"iPhone"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("begin with a revoked token: status = %d, want 401: %s", rec.Code, body)
	}
	if n := sessionCount(app, "stale"); n != 0 {
		t.Errorf("a ceremony session was opened for a revoked token (%d sessions)", n)
	}
}

// TestSignupOpenUnchanged: the default side of the gate still mints accounts.
func TestSignupOpenUnchanged(t *testing.T) {
	_, mux := setupWebauthnAppWithSignup(t, signup.NewGate(signup.Open))
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"open","nickname":"Alice"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("begin status = %d, want 200: %s", rec.Code, body)
	}
}

// TestSignupFromEnvParsing: unset means open (an upgrade must not lock the
// operator out), and an unrecognised value is fatal rather than defaulting —
// `closed` misspelt must never boot wide open.
func TestSignupFromEnvParsing(t *testing.T) {
	t.Setenv("SHOPPINGLIST_RP_ID", "shop.example.com")
	for _, tc := range []struct {
		value   string
		want    signup.Mode
		wantErr bool
	}{
		{value: "", want: signup.Open},
		{value: "open", want: signup.Open},
		{value: "closed", want: signup.Closed},
		{value: "CLOSED", want: signup.Closed},
		{value: "  closed  ", want: signup.Closed},
		{value: "invite", want: signup.Invite},
		{value: "Invite", want: signup.Invite},
		{value: "cosed", wantErr: true},
		{value: "invites", wantErr: true},
		{value: "false", wantErr: true},
	} {
		t.Setenv("SHOPPINGLIST_SIGNUP", tc.value)
		cfg, err := FromEnv()
		if tc.wantErr {
			if err == nil {
				t.Errorf("SHOPPINGLIST_SIGNUP=%q should be rejected", tc.value)
			}
			continue
		}
		if err != nil {
			t.Errorf("SHOPPINGLIST_SIGNUP=%q: unexpected error: %v", tc.value, err)
			continue
		}
		if cfg.Signup != tc.want {
			t.Errorf("SHOPPINGLIST_SIGNUP=%q: Signup = %q, want %q", tc.value, cfg.Signup, tc.want)
		}
	}
}

// TestPasskeysSwitch ([D-76]): SHOPPINGLIST_PASSKEYS=off needs no RP-ID but
// still needs the app's origin; unset means on (every deployment used
// passkeys before the switch existed); a misspelling is fatal.
func TestPasskeysSwitch(t *testing.T) {
	t.Setenv("SHOPPINGLIST_RP_ID", "")
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "")
	t.Setenv("SHOPPINGLIST_APP_URL", "")

	t.Setenv(PasskeysEnv, "")
	if _, err := FromEnv(); err == nil {
		t.Error("unset switch means on, which still requires SHOPPINGLIST_RP_ID")
	}

	t.Setenv(PasskeysEnv, "off")
	if _, err := FromEnv(); err == nil {
		t.Error("off with neither SHOPPINGLIST_RP_ORIGIN nor SHOPPINGLIST_APP_URL should be rejected")
	}
	t.Setenv("SHOPPINGLIST_APP_URL", "https://list.example.com/")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("off with SHOPPINGLIST_APP_URL: %v", err)
	}
	if cfg.Enabled || cfg.RPOrigin != "https://list.example.com" {
		t.Errorf("cfg = %+v, want disabled with the app URL as origin", cfg)
	}
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "https://rp.example.com")
	if cfg, _ := FromEnv(); cfg == nil || cfg.RPOrigin != "https://rp.example.com" {
		t.Errorf("cfg = %+v, want SHOPPINGLIST_RP_ORIGIN to win over the app URL", cfg)
	}

	t.Setenv(PasskeysEnv, "no")
	if _, err := FromEnv(); err == nil {
		t.Error("a misspelled switch must fail the boot, not guess")
	}
}

// browser_id arrives unauthenticated and is stored with SaveNoValidate, so it
// is bounded on every route that takes it (the client sends a UUID).
func TestBrowserIDIsBounded(t *testing.T) {
	app, mux := setupWebauthnApp(t)
	long := strings.Repeat("b", maxBrowserIDLen+1)
	for _, path := range []string{"/api/passkey/register/begin", "/api/passkey/login/begin"} {
		rec, body := testutil.DoReq(mux, http.MethodPost, path, `{"browser_id":"`+long+`"}`, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s with an oversized browser_id: status %d, want 400: %s", path, rec.Code, body)
		}
	}
	if n := sessionCount(app, ""); n != 0 {
		t.Errorf("ceremony sessions = %d, want 0", n)
	}
	for _, path := range []string{"/api/passkey/register/finish", "/api/passkey/login/finish"} {
		rec, body := testutil.DoReq(mux, http.MethodPost, path, `{}`, map[string]string{"X-Browser-Id": long})
		if rec.Code != http.StatusBadRequest || !strings.Contains(body, "X-Browser-Id") {
			t.Errorf("%s with an oversized X-Browser-Id: status %d, want the header's 400: %s", path, rec.Code, body)
		}
	}
	// A UUID-sized id still works.
	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/login/begin",
		`{"browser_id":"`+strings.Repeat("b", maxBrowserIDLen)+`"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("browser_id at the cap: status %d, want 200: %s", rec.Code, body)
	}
}

// TestSignupInviteBegin ([D-241]): on an invite-only instance a visitor with
// no link is refused before any passkey prompt, one with a list's live link is
// let in, and the ceremony session carries the link's hash — never the token
// — to finish.
func TestSignupInviteBegin(t *testing.T) {
	app, mux := setupWebauthnAppWithSignup(t, signup.NewGate(signup.Invite))
	owner, _ := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, owner, "Wocheneinkauf")

	col, _ := app.FindCollectionByNameOrId("invites")
	inv := core.NewRecord(col)
	inv.Set("list", listID)
	inv.Set("created_by", owner)
	h, _ := randid.LookupHash("family-link")
	inv.Set("token_hash", h)
	inv.Set("expires_at", types.NowDateTime().Add(time.Hour))
	if err := app.SaveNoValidate(inv); err != nil {
		t.Fatal(err)
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"nolink","nickname":"Mallory"}`, nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("begin without a link = %d, want 403: %s", rec.Code, body)
	}
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"badlink","nickname":"Mallory","invite":"guessed"}`, nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("begin with an unknown link = %d, want 403: %s", rec.Code, body)
	}

	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/passkey/register/begin",
		`{"browser_id":"family","nickname":"Bob","invite":"family-link"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("begin with the list's link = %d, want 200: %s", rec.Code, body)
	}
	s, err := peekSession(app, "family", sessionTypeRegister)
	if err != nil {
		t.Fatal(err)
	}
	if stored := fmt.Sprintf("%+v", *s.Pending); strings.Contains(stored, "family-link") || s.Pending.Ticket.Invite != h {
		t.Errorf("session should carry the link's hash and not the token: %s", stored)
	}
	if n, _ := app.CountRecords("accounts"); n != 1 {
		t.Errorf("accounts after begin = %d, want 1 (begin saves nothing)", n)
	}
}

// TestNewAccountJoinsInTheSameTransaction ([D-241]): the account, its passkey
// and the membership its link names are saved together, and a refusal from
// the gate saves none of them.
func TestNewAccountJoinsInTheSameTransaction(t *testing.T) {
	app := testutil.NewApp(t)
	listID := testutil.CreateList(t, app, "Wocheneinkauf")
	newAccount := func(nick string) *core.Record {
		p := &pendingAccount{ID: randid.ID(), Handle: randid.Handle(), Nickname: nick}
		rec, err := p.record(app)
		if err != nil {
			t.Fatal(err)
		}
		return rec
	}

	acct := newAccount("Bob")
	err := persistNewAccountAndCredential(app, acct, &webauthn.Credential{ID: []byte("bob-key")},
		func(core.App) (string, error) { return listID, nil })
	if err != nil {
		t.Fatalf("persist: %v", err)
	}
	if m, _ := app.FindFirstRecordByFilter("memberships", "account = {:a} && list = {:l}",
		map[string]any{"a": acct.Id, "l": listID}); m == nil {
		t.Error("the new account is not on the link's list")
	}

	err = persistNewAccountAndCredential(app, newAccount("Mallory"), &webauthn.Credential{ID: []byte("m-key")},
		func(core.App) (string, error) { return "", signup.ErrRefused })
	if !errors.Is(err, signup.ErrRefused) {
		t.Errorf("refused persist err = %v, want ErrRefused", err)
	}
	if n, _ := app.CountRecords("accounts"); n != 1 {
		t.Errorf("accounts = %d after a refusal, want 1", n)
	}
	if n, _ := app.CountRecords("credentials"); n != 1 {
		t.Errorf("credentials = %d after a refusal, want 1", n)
	}
}

// TestOversizeFinishIs413: a finish body past security.SmallBodyMax sent
// without a Content-Length, so PocketBase cannot refuse it up front, is the
// 413 the limit promises, not a failed verification.
func TestOversizeFinishIs413(t *testing.T) {
	_, mux := setupWebauthnApp(t)
	for _, path := range []string{"/api/passkey/register/finish", "/api/passkey/login/finish"} {
		big := `{"id":"` + strings.Repeat("a", security.SmallBodyMax) + `"}`
		req := httptest.NewRequest(http.MethodPost, path, io.MultiReader(strings.NewReader(big)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Browser-Id", "big")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s with an unannounced oversize body = %d, want 413: %s", path, rec.Code, rec.Body)
		}
	}
}
