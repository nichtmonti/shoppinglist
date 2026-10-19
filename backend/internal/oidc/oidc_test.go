package oidc

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/testutil"
)

// routes registers the methods endpoint with passkeys on and open — the
// default deployment — for tests that are about the OIDC half.
func routes(r *router.RouterGroup[*core.RequestEvent]) {
	RegisterRoutes(r, Passkeys{Enabled: true, Signup: true, SignupByLink: true})
}

func getMethods(t *testing.T, mux http.Handler, headers map[string]string) methodsResponse {
	t.Helper()
	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/auth/methods", "", headers)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/auth/methods = %d, want 200: %s", rec.Code, body)
	}
	var got methodsResponse
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return got
}

// TestMethodsOidcDisabledByDefault: the unauthenticated probe must not
// advertise OIDC on an instance that never configured it — the AuthScreen
// renders its button from exactly this answer.
func TestMethodsOidcDisabledByDefault(t *testing.T) {
	_, mux := testutil.NewMux(t, routes)
	got := getMethods(t, mux, nil)
	if got.Oidc.Enabled {
		t.Errorf("oidc.enabled = true with no provider configured: %+v", got)
	}
	if !got.Passkeys.Enabled || !got.Passkeys.Signup {
		t.Errorf("passkeys = %+v, want the configuration it was registered with", got.Passkeys)
	}
}

// TestMethodsReflectOidcEnv: after Apply (the serve-time seeding
// the operator's env drives) the probe reports the provider and its display
// label — the label is what the button renders ("Weiter mit Keycloak") — and
// SHOPPINGLIST_OIDC=off takes both away again ([D-76]).
func TestMethodsReflectOidcEnv(t *testing.T) {
	app, mux := testutil.NewMux(t, routes)
	t.Setenv("SHOPPINGLIST_OIDC", "on")
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_ID", "my-client")
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_SECRET", "s3cret")
	t.Setenv("SHOPPINGLIST_OIDC_AUTH_URL", "https://idp.example.com/auth")
	t.Setenv("SHOPPINGLIST_OIDC_TOKEN_URL", "https://idp.example.com/token")
	t.Setenv("SHOPPINGLIST_OIDC_USERINFO_URL", "https://idp.example.com/userinfo")
	t.Setenv("SHOPPINGLIST_OIDC_NAME", "Keycloak")
	if err := applyEnv(app); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	got := getMethods(t, mux, nil).Oidc
	if !got.Enabled || got.Provider != "oidc" || got.Name != "Keycloak" {
		t.Errorf("oidc = %+v, want {true oidc Keycloak}", got)
	}

	t.Setenv("SHOPPINGLIST_OIDC", "off")
	if err := applyEnv(app); err != nil {
		t.Fatalf("Apply off: %v", err)
	}
	if got := getMethods(t, mux, nil).Oidc; got.Enabled {
		t.Errorf("oidc = %+v after SHOPPINGLIST_OIDC=off, want disabled", got)
	}
}

// TestMethodsReportTheEnvProviderAheadOfADashboardOne: a provider an operator
// added through the dashboard survives Apply and sits ahead of the
// environment's in the collection's list; the probe still reports the
// environment's provider and the label the operator set for it.
func TestMethodsReportTheEnvProviderAheadOfADashboardOne(t *testing.T) {
	app, mux := testutil.NewMux(t, routes)
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatal(err)
	}
	col.OAuth2.Providers = []core.OAuth2ProviderConfig{{
		Name: "gitlab", ClientId: "dash", ClientSecret: "dash", DisplayName: "GitLab",
	}}
	if err := app.Save(col); err != nil {
		t.Fatalf("save dashboard provider: %v", err)
	}
	t.Setenv("SHOPPINGLIST_OIDC", "on")
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_ID", "my-client")
	t.Setenv("SHOPPINGLIST_OIDC_CLIENT_SECRET", "s3cret")
	t.Setenv("SHOPPINGLIST_OIDC_AUTH_URL", "https://idp.example.com/auth")
	t.Setenv("SHOPPINGLIST_OIDC_TOKEN_URL", "https://idp.example.com/token")
	t.Setenv("SHOPPINGLIST_OIDC_USERINFO_URL", "https://idp.example.com/userinfo")
	t.Setenv("SHOPPINGLIST_OIDC_NAME", "Keycloak")
	if err := applyEnv(app); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	got := getMethods(t, mux, nil).Oidc
	if !got.Enabled || got.Provider != "oidc" || got.Name != "Keycloak" {
		t.Errorf("oidc = %+v, want {true oidc Keycloak}", got)
	}
}

// TestMethodsPasskeysOffNeverOffersSignup: with passkeys off there is no
// passkey signup to offer, whatever SHOPPINGLIST_SIGNUP says.
func TestMethodsPasskeysOffNeverOffersSignup(t *testing.T) {
	_, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		RegisterRoutes(r, Passkeys{Enabled: false, Signup: true, SignupByLink: true})
	})
	if got := getMethods(t, mux, nil).Passkeys; got.Enabled || got.Signup || got.SignupByLink {
		t.Errorf("passkeys = %+v, want {false false false}", got)
	}
}

// TestMethodsReportInviteOnlySignup ([D-241]): an invite-only instance tells
// the auth screen that signup needs a link, so it offers "Konto erstellen"
// only to a visitor who holds one.
func TestMethodsReportInviteOnlySignup(t *testing.T) {
	_, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		RegisterRoutes(r, Passkeys{Enabled: true, Signup: false, SignupByLink: true})
	})
	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/auth/methods", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, body)
	}
	var raw struct {
		Passkeys map[string]bool `json:"passkeys"`
	}
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatal(err)
	}
	if raw.Passkeys["signup"] || !raw.Passkeys["signup_by_link"] {
		t.Errorf("passkeys = %v, want signup false and signup_by_link true", raw.Passkeys)
	}
}

// applyEnv is Apply with the configuration FromEnv reads, as the server boots.
func applyEnv(app core.App) error {
	cfg, err := FromEnv()
	if err != nil {
		return err
	}
	return Apply(app, cfg)
}
