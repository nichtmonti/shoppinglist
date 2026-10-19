package oidc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// issuerServer serves a discovery document for its own URL (+ path), the way
// a provider does, and counts the requests. status, when non-zero, is
// answered instead of the document while `failing` requests remain.
type issuerServer struct {
	*httptest.Server
	issuer   string
	doc      map[string]string
	requests atomic.Int32
	failing  atomic.Int32
	html     atomic.Bool // answer 200 with an HTML page instead of the document
}

func newIssuer(t *testing.T, path string) *issuerServer {
	t.Helper()
	s := &issuerServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		if s.failing.Load() > 0 {
			s.failing.Add(-1)
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path != path+wellKnownPath {
			http.NotFound(w, r)
			return
		}
		if s.html.Load() {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<!doctype html><html><body>Sign in to the network</body></html>"))
			return
		}
		_ = json.NewEncoder(w).Encode(s.doc)
	}))
	t.Cleanup(s.Close)
	s.issuer = s.URL + path
	s.doc = map[string]string{
		"issuer":                 s.issuer,
		"authorization_endpoint": s.issuer + "/auth",
		"token_endpoint":         s.issuer + "/token",
		"userinfo_endpoint":      s.issuer + "/userinfo",
	}
	return s
}

// noRetryWait makes discovery's retries immediate for the test.
func noRetryWait(t *testing.T) {
	t.Helper()
	old := discoveryRetryDelays
	discoveryRetryDelays = []time.Duration{0, 0}
	t.Cleanup(func() { discoveryRetryDelays = old })
}

func issuerEnv(t *testing.T, issuer string) {
	t.Helper()
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	t.Setenv(oidcClientIDEnv, "shoppinglist")
	t.Setenv(oidcClientSecretEnv, "s3cret")
	t.Setenv(oidcIssuerEnv, issuer)
}

func oidcProvider(t *testing.T, app core.App) core.OAuth2ProviderConfig {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	p, ok := col.OAuth2.GetProviderConfig(oidcProviderName)
	if !ok {
		t.Fatal("no oidc provider")
	}
	return p
}

func TestFromEnvIssuerReplacesTheThreeURLs(t *testing.T) {
	issuerEnv(t, "https://idp.example.com/realms/hh")
	env, err := FromEnv()
	if err != nil {
		t.Fatalf("issuer + client id + secret should be a full configuration: %v", err)
	}
	if env.Issuer != "https://idp.example.com/realms/hh" || env.AuthURL != "" {
		t.Errorf("env = %+v", env)
	}
}

func TestFromEnvIssuerAndURLsTogetherFail(t *testing.T) {
	issuerEnv(t, "https://idp.example.com/realms/hh")
	t.Setenv(oidcAuthURLEnv, "https://idp.example.com/auth")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Errorf("err = %v, want an either/or refusal", err)
	}
}

func TestFromEnvInvalidIssuerFails(t *testing.T) {
	issuerEnv(t, "idp.example.com")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), oidcIssuerEnv) {
		t.Errorf("err = %v, want a refusal naming %s", err, oidcIssuerEnv)
	}
}

func TestApplyDiscoversTheEndpoints(t *testing.T) {
	for _, form := range []string{"issuer", "issuer with a trailing slash", "document URL"} {
		t.Run(form, func(t *testing.T) {
			idp := newIssuer(t, "/realms/hh")
			value := map[string]string{
				"issuer":                       idp.issuer,
				"issuer with a trailing slash": idp.issuer + "/",
				"document URL":                 idp.issuer + wellKnownPath,
			}[form]
			issuerEnv(t, value)
			app := testutil.NewApp(t)

			if err := applyEnv(app); err != nil {
				t.Fatalf("apply: %v", err)
			}
			p := oidcProvider(t, app)
			if p.AuthURL != idp.issuer+"/auth" || p.TokenURL != idp.issuer+"/token" ||
				p.UserInfoURL != idp.issuer+"/userinfo" || p.ClientId != "shoppinglist" {
				t.Errorf("provider = %+v", p)
			}
			if storedIssuer(&p) != idp.issuer {
				t.Errorf("stored issuer = %q, want %q", storedIssuer(&p), idp.issuer)
			}
		})
	}
}

// Discovery §4.3: a document for another issuer is a wrong URL, not a source
// of endpoints.
func TestApplyRefusesADocumentForAnotherIssuer(t *testing.T) {
	idp := newIssuer(t, "/realms/hh")
	idp.doc["issuer"] = idp.URL + "/realms/other"
	issuerEnv(t, idp.issuer)
	if err := applyEnv(testutil.NewApp(t)); err == nil || !strings.Contains(err.Error(), "names issuer") {
		t.Errorf("err = %v, want an issuer-mismatch refusal", err)
	}
}

func TestApplyRefusesADocumentWithoutUserinfo(t *testing.T) {
	idp := newIssuer(t, "/realms/hh")
	delete(idp.doc, "userinfo_endpoint")
	issuerEnv(t, idp.issuer)
	err := applyEnv(testutil.NewApp(t))
	if err == nil || !strings.Contains(err.Error(), "userinfo_endpoint") || !strings.Contains(err.Error(), oidcUserinfoURLEnv) {
		t.Errorf("err = %v, want a refusal naming the missing endpoint and the variables to use instead", err)
	}
}

// A document that arrives but is wrong fails the boot even when an earlier
// start stored endpoints for the same issuer: fetching it again returns the
// same document, so it is neither retried nor papered over ([D-61]).
func TestApplyRefusesADocumentThatIsWrongEvenWithStoredEndpoints(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*issuerServer)
		want   string
	}{
		{"not JSON (an HTML page)", func(s *issuerServer) { s.html.Store(true) }, "not a discovery document"},
		{"a relative token endpoint", func(s *issuerServer) { s.doc["token_endpoint"] = "/token" }, "token_endpoint"},
		{"a relative authorization endpoint", func(s *issuerServer) { s.doc["authorization_endpoint"] = "/auth" }, "authorization_endpoint"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			noRetryWait(t)
			idp := newIssuer(t, "/realms/hh")
			issuerEnv(t, idp.issuer)
			app := testutil.NewApp(t)
			if err := applyEnv(app); err != nil {
				t.Fatalf("first apply: %v", err)
			}
			before := idp.requests.Load()

			c.mutate(idp)
			err := applyEnv(app)
			if err == nil || !strings.Contains(err.Error(), oidcIssuerEnv) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want a refusal naming %s and %q", err, oidcIssuerEnv, c.want)
			}
			if got := idp.requests.Load() - before; got != 1 {
				t.Errorf("requests = %d, want 1: a wrong document is not retried", got)
			}
		})
	}
}

// A provider that starts alongside this server answers a moment later.
func TestApplyRetriesAProviderThatIsNotUpYet(t *testing.T) {
	noRetryWait(t)
	idp := newIssuer(t, "/realms/hh")
	idp.failing.Store(2)
	issuerEnv(t, idp.issuer)
	app := testutil.NewApp(t)
	if err := applyEnv(app); err != nil {
		t.Fatalf("apply after two failed fetches: %v", err)
	}
	if got := idp.requests.Load(); got != 3 {
		t.Errorf("requests = %d, want 3", got)
	}
	if oidcProvider(t, app).AuthURL == "" {
		t.Error("no endpoints after the retry")
	}
}

// A provider that is down must not keep the app — passkey sign-ins included —
// from starting, once its endpoints are known from an earlier start.
func TestApplyUsesTheStoredEndpointsWhenTheProviderIsDown(t *testing.T) {
	noRetryWait(t)
	idp := newIssuer(t, "/realms/hh")
	issuerEnv(t, idp.issuer)
	app := testutil.NewApp(t)
	if err := applyEnv(app); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	before := oidcProvider(t, app)

	idp.failing.Store(100)
	if err := applyEnv(app); err != nil {
		t.Fatalf("apply with the provider down: %v", err)
	}
	after := oidcProvider(t, app)
	if after.AuthURL != before.AuthURL || after.TokenURL != before.TokenURL || after.UserInfoURL != before.UserInfoURL {
		t.Errorf("endpoints changed: %+v → %+v", before, after)
	}
}

func TestApplyFirstStartWithTheProviderDownFails(t *testing.T) {
	noRetryWait(t)
	idp := newIssuer(t, "/realms/hh")
	idp.failing.Store(100)
	issuerEnv(t, idp.issuer)
	if err := applyEnv(testutil.NewApp(t)); err == nil || !strings.Contains(err.Error(), oidcIssuerEnv) {
		t.Errorf("err = %v, want a refusal naming %s", err, oidcIssuerEnv)
	}
}

// Stored endpoints stand in only for the issuer they were discovered from:
// after the variable moves to another issuer, the old provider's URLs would
// sign users in at the wrong place.
func TestApplyDoesNotReuseAnotherIssuersEndpoints(t *testing.T) {
	noRetryWait(t)
	old := newIssuer(t, "/realms/old")
	issuerEnv(t, old.issuer)
	app := testutil.NewApp(t)
	if err := applyEnv(app); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	moved := newIssuer(t, "/realms/new")
	moved.failing.Store(100)
	t.Setenv(oidcIssuerEnv, moved.issuer)
	if err := applyEnv(app); err == nil {
		t.Error("the old issuer's endpoints were reused for a new issuer")
	}
}

// [D-65]: a boot must not be a write — discovered endpoints included.
func TestApplyDiscoveryNoWriteWhenUnchanged(t *testing.T) {
	idp := newIssuer(t, "/realms/hh")
	issuerEnv(t, idp.issuer)
	app := testutil.NewApp(t)
	if err := applyEnv(app); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	saves := 0
	app.OnModelAfterUpdateSuccess().BindFunc(func(e *core.ModelEvent) error {
		if col, ok := e.Model.(*core.Collection); ok && col.Name == "accounts" {
			saves++
		}
		return e.Next()
	})
	if err := applyEnv(app); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if saves != 0 {
		t.Errorf("unchanged discovery caused %d saves, want 0", saves)
	}
}
