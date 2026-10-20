package oidc

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/settings"
	"shoppinglist/internal/testutil"
)

// FromEnv reads the settings as the start does, for the tests that set them.
func FromEnv() (*Config, error) {
	s, err := settings.ReadServe()
	if err != nil {
		return nil, err
	}
	return FromSettings(s)
}

// clearOidcEnv isolates each case from the other six vars (tests share one
// process env; empty reads as unset in FromEnv).
func clearOidcEnv(t *testing.T) {
	t.Helper()
	for _, e := range []string{
		oidcEnv, oidcClientIDEnv, oidcClientSecretEnv, oidcAuthURLEnv,
		oidcTokenURLEnv, oidcUserinfoURLEnv, oidcNameEnv, oidcIssuerEnv,
	} {
		t.Setenv(e, "")
	}
}

func TestFromEnvUnsetMeansDisabled(t *testing.T) {
	clearOidcEnv(t)
	env, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env != nil {
		t.Errorf("FromEnv = %+v with no env set, want nil", env)
	}
}

func TestFromEnvPartialConfigFails(t *testing.T) {
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	t.Setenv(oidcClientIDEnv, "my-client")

	_, err := FromEnv()
	if err == nil {
		t.Fatal("partial OIDC config must be a boot failure naming the missing vars")
	}
	for _, want := range []string{
		oidcClientSecretEnv, oidcAuthURLEnv, oidcTokenURLEnv, oidcUserinfoURLEnv,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %s", err.Error(), want)
		}
	}
}

func TestFromEnvInvalidURLFails(t *testing.T) {
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	t.Setenv(oidcClientIDEnv, "my-client")
	t.Setenv(oidcClientSecretEnv, "s3cret")
	t.Setenv(oidcAuthURLEnv, "keycloak.example.com/realms/hh/protocol/openid-connect/auth")
	t.Setenv(oidcTokenURLEnv, "https://keycloak.example.com/token")
	t.Setenv(oidcUserinfoURLEnv, "https://keycloak.example.com/userinfo")

	if _, err := FromEnv(); err == nil {
		t.Fatal("scheme-less auth URL must fail at boot, not surface later")
	}
}

func TestFromEnvFull(t *testing.T) {
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	t.Setenv(oidcClientIDEnv, "my-client")
	t.Setenv(oidcClientSecretEnv, "s3cret")
	t.Setenv(oidcAuthURLEnv, "https://keycloak.example.com/auth")
	t.Setenv(oidcTokenURLEnv, "https://keycloak.example.com/token")
	t.Setenv(oidcUserinfoURLEnv, "https://keycloak.example.com/userinfo")

	env, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env == nil {
		t.Fatal("env = nil with full configuration")
	}
	if env.ClientID != "my-client" || env.ClientSecret != "s3cret" {
		t.Errorf("client credentials not carried: %+v", env)
	}
	if env.DisplayName != "OIDC" {
		t.Errorf("DisplayName = %q, want default %q", env.DisplayName, "OIDC")
	}

	t.Setenv(oidcNameEnv, "Keycloak")
	env, err = FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env.DisplayName != "Keycloak" {
		t.Errorf("DisplayName = %q, want %q", env.DisplayName, "Keycloak")
	}
}

// TestApplyUnsetIsNoop pins the zero-surface property [D-76] promises: a
// deployment without the env keeps OAuth2 disabled entirely.
func TestApplyUnsetIsNoop(t *testing.T) {
	clearOidcEnv(t)
	app := testutil.NewApp(t)

	if err := applyEnv(app); err != nil {
		t.Fatalf("apply: %v", err)
	}
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	if col.OAuth2.Enabled {
		t.Error("OAuth2.Enabled = true with no OIDC env — the auth-with-oauth2 route would be live")
	}
	if len(col.OAuth2.Providers) != 0 {
		t.Errorf("providers = %v, want none", col.OAuth2.Providers)
	}
}

func TestApplySeedsProvider(t *testing.T) {
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	app := testutil.NewApp(t)
	t.Setenv(oidcClientIDEnv, "my-client")
	t.Setenv(oidcClientSecretEnv, "s3cret")
	t.Setenv(oidcAuthURLEnv, "https://keycloak.example.com/auth")
	t.Setenv(oidcTokenURLEnv, "https://keycloak.example.com/token")
	t.Setenv(oidcUserinfoURLEnv, "https://keycloak.example.com/userinfo")
	t.Setenv(oidcNameEnv, "Keycloak")

	if err := applyEnv(app); err != nil {
		t.Fatalf("apply: %v", err)
	}

	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	if !col.OAuth2.Enabled {
		t.Error("OAuth2.Enabled = false after seeding")
	}
	p, ok := col.OAuth2.GetProviderConfig("oidc")
	if !ok {
		t.Fatal("no oidc provider after seeding")
	}
	if p.ClientId != "my-client" || p.ClientSecret != "s3cret" ||
		p.AuthURL != "https://keycloak.example.com/auth" ||
		p.TokenURL != "https://keycloak.example.com/token" ||
		p.UserInfoURL != "https://keycloak.example.com/userinfo" ||
		p.DisplayName != "Keycloak" {
		t.Errorf("provider row not carried: %+v", p)
	}
	// Re-read through a fresh find: proves persistence, not just memory.
	col2, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("re-find accounts: %v", err)
	}
	if _, ok := col2.OAuth2.GetProviderConfig("oidc"); !ok {
		t.Error("provider not persisted")
	}
}

// TestApplyNoWriteWhenUnchanged: a boot must not be a write ([D-65]).
func TestApplyNoWriteWhenUnchanged(t *testing.T) {
	clearOidcEnv(t)
	app := testutil.NewApp(t)
	seedOidcEnv(t)
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
		t.Errorf("unchanged env caused %d accounts collection saves, want 0", saves)
	}
}

// TestApplyEnvWinsPreservesOthers: the env row is replaced wholesale
// while providers configured through the dashboard survive.
func TestApplyEnvWinsPreservesOthers(t *testing.T) {
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	app := testutil.NewApp(t)

	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	col.OAuth2.Enabled = true
	col.OAuth2.Providers = []core.OAuth2ProviderConfig{
		{Name: "google", ClientId: "g", ClientSecret: "gs"},
		{Name: "oidc", ClientId: "stale", ClientSecret: "stale",
			AuthURL:  "https://old.example.com/auth",
			TokenURL: "https://old.example.com/token"},
	}
	if err := app.Save(col); err != nil {
		t.Fatalf("seed pre-existing providers: %v", err)
	}

	seedOidcEnv(t)
	if err := applyEnv(app); err != nil {
		t.Fatalf("apply: %v", err)
	}

	got, _ := app.FindCollectionByNameOrId("accounts")
	if _, ok := got.OAuth2.GetProviderConfig("google"); !ok {
		t.Error("dashboard-configured google provider was dropped")
	}
	p, ok := got.OAuth2.GetProviderConfig("oidc")
	if !ok {
		t.Fatal("oidc provider missing after env apply")
	}
	if p.ClientId != "env-client" {
		t.Errorf("oidc ClientId = %q, want the env value to win over the stale row", p.ClientId)
	}
}

// seedOidcEnv sets a full valid SHOPPINGLIST_OIDC_* set.
func seedOidcEnv(t *testing.T) {
	t.Helper()
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	t.Setenv(oidcClientIDEnv, "env-client")
	t.Setenv(oidcClientSecretEnv, "env-secret")
	t.Setenv(oidcAuthURLEnv, "https://idp.example.com/auth")
	t.Setenv(oidcTokenURLEnv, "https://idp.example.com/token")
	t.Setenv(oidcUserinfoURLEnv, "https://idp.example.com/userinfo")
}

// setOidcConnection sets the five connection variables to a valid issuer.
func setOidcConnection(t *testing.T) {
	t.Helper()
	t.Setenv(oidcClientIDEnv, "my-client")
	t.Setenv(oidcClientSecretEnv, "s3cret")
	t.Setenv(oidcAuthURLEnv, "https://idp.example.com/auth")
	t.Setenv(oidcTokenURLEnv, "https://idp.example.com/token")
	t.Setenv(oidcUserinfoURLEnv, "https://idp.example.com/userinfo")
}

// [D-76]: connection variables without the switch are how every deployment
// configured OIDC before it existed — silently turning that login off on
// upgrade would lock its users out, so it is a boot failure that says what
// to set.
func TestFromEnvConnectionWithoutSwitchFails(t *testing.T) {
	clearOidcEnv(t)
	setOidcConnection(t)
	_, err := FromEnv()
	if err == nil || !strings.Contains(err.Error(), oidcEnv+"=on") {
		t.Fatalf("err = %v, want a boot failure telling the operator to set %s=on", err, oidcEnv)
	}
}

func TestFromEnvOffIgnoresConnection(t *testing.T) {
	clearOidcEnv(t)
	setOidcConnection(t)
	t.Setenv(oidcEnv, "off")
	env, err := FromEnv()
	if err != nil || env != nil {
		t.Fatalf("FromEnv = %+v, %v; want nil, nil with %s=off", env, err, oidcEnv)
	}
}

func TestFromEnvOnWithoutConnectionFails(t *testing.T) {
	clearOidcEnv(t)
	t.Setenv(oidcEnv, "on")
	_, err := FromEnv()
	if err == nil || !strings.Contains(err.Error(), oidcClientIDEnv) {
		t.Fatalf("err = %v, want a failure naming the missing connection variables", err)
	}
}

func TestFromEnvUnknownSwitchFails(t *testing.T) {
	clearOidcEnv(t)
	setOidcConnection(t)
	t.Setenv(oidcEnv, "yes")
	if _, err := FromEnv(); err == nil {
		t.Fatal("a misspelled switch must fail the boot, not guess")
	}
}

// [D-76]: the environment is authoritative — switching OIDC off turns off a
// provider an earlier boot (or the dashboard) enabled, and keeps its rows so
// switching back on restores them.
func TestApplyOffDisablesConfiguredProvider(t *testing.T) {
	clearOidcEnv(t)
	setOidcConnection(t)
	t.Setenv(oidcEnv, "on")
	app := testutil.NewApp(t)
	if err := applyEnv(app); err != nil {
		t.Fatalf("apply on: %v", err)
	}

	t.Setenv(oidcEnv, "off")
	if err := applyEnv(app); err != nil {
		t.Fatalf("apply off: %v", err)
	}
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	if col.OAuth2.Enabled {
		t.Error("OAuth2 still enabled after SHOPPINGLIST_OIDC=off")
	}
	if len(col.OAuth2.Providers) != 1 {
		t.Errorf("providers = %v, want the one row kept for a later switch back on", col.OAuth2.Providers)
	}
}
