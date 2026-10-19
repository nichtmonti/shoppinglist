// OIDC login configuration (§5.9, [D-76]): SHOPPINGLIST_OIDC switches
// the login on or off, and the SHOPPINGLIST_OIDC_* variables seed the accounts
// collection's OAuth2 config.
//
// Apply runs from main.go's post-migrations OnServe hook, not OnBootstrap:
// the OAuth2 config lives on the accounts collection, which a fresh database
// does not have before the migrations run.
//
// The environment is authoritative ([D-76]): with SHOPPINGLIST_OIDC off or
// unset, Apply switches OAuth2 off on the collection, dashboard-added
// providers included.

package oidc

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/envflag"
	"shoppinglist/internal/oidclogin"
)

const (
	oidcEnv             = "SHOPPINGLIST_OIDC"
	oidcClientIDEnv     = "SHOPPINGLIST_OIDC_CLIENT_ID"
	oidcClientSecretEnv = "SHOPPINGLIST_OIDC_CLIENT_SECRET"
	oidcAuthURLEnv      = "SHOPPINGLIST_OIDC_AUTH_URL"
	oidcTokenURLEnv     = "SHOPPINGLIST_OIDC_TOKEN_URL"
	oidcUserinfoURLEnv  = "SHOPPINGLIST_OIDC_USERINFO_URL"
	oidcNameEnv         = "SHOPPINGLIST_OIDC_NAME"
	oidcIssuerEnv       = "SHOPPINGLIST_OIDC_ISSUER"
)

// oidcProviderName is PocketBase's generic OpenID Connect provider
// (tools/auth: NameOIDC), which takes its three endpoint URLs from the config.
const oidcProviderName = oidclogin.ProviderName

// issuerExtraKey records on the provider row which issuer its URLs were
// discovered from, so a boot that cannot reach the provider knows whether the
// stored URLs belong to the configured issuer.
const issuerExtraKey = "issuer"

// Config is the parsed SHOPPINGLIST_OIDC_* deployment configuration.
type Config struct {
	ClientID     string
	ClientSecret string
	// Issuer, when set, is where Apply discovers the three URLs below,
	// which are then empty here.
	Issuer      string
	AuthURL     string
	TokenURL    string
	UserinfoURL string
	// DisplayName is the label the auth screen shows (from _NAME).
	// "OIDC" when unset.
	DisplayName string
}

// FromEnv parses the OIDC variables. nil means OIDC is off.
//
// SHOPPINGLIST_OIDC=on requires the client id and secret and either
// SHOPPINGLIST_OIDC_ISSUER or all three endpoint URLs; a half-configured set
// fails the boot naming the missing variable ([D-61]), as does an unknown
// switch value. Connection variables set while the switch is unset also fail
// it ([D-76]): silently switching off a login the operator configured would
// lock its users out. With `off` they are ignored.
func FromEnv() (*Config, error) {
	clientID := envflag.Get(oidcClientIDEnv)
	secret := envflag.Get(oidcClientSecretEnv)
	authURL := envflag.Get(oidcAuthURLEnv)
	tokenURL := envflag.Get(oidcTokenURLEnv)
	userinfoURL := envflag.Get(oidcUserinfoURLEnv)
	issuer := envflag.Get(oidcIssuerEnv)
	anySet := clientID != "" || secret != "" || issuer != "" || authURL != "" || tokenURL != "" || userinfoURL != ""

	if envflag.Get(oidcEnv) == "" {
		if anySet {
			return nil, fmt.Errorf("%s is not set, but %s and its siblings are: set %s=on to keep the OIDC login, or %s=off to turn it off",
				oidcEnv, oidcClientIDEnv, oidcEnv, oidcEnv)
		}
		return nil, nil
	}
	if on, err := envflag.OnOff(oidcEnv, false); err != nil || !on {
		return nil, err
	}

	explicit := authURL != "" || tokenURL != "" || userinfoURL != ""
	if issuer != "" && explicit {
		return nil, fmt.Errorf("set either %s or %s/%s/%s, not both",
			oidcIssuerEnv, oidcAuthURLEnv, oidcTokenURLEnv, oidcUserinfoURLEnv)
	}
	required := []struct{ env, val string }{
		{oidcClientIDEnv, clientID},
		{oidcClientSecretEnv, secret},
	}
	endpoints := []struct{ env, val string }{{oidcIssuerEnv, issuer}}
	// Named for both ways out when neither is set.
	issuerOrURLs := fmt.Sprintf("%s (or %s, %s and %s)", oidcIssuerEnv, oidcAuthURLEnv, oidcTokenURLEnv, oidcUserinfoURLEnv)
	if explicit {
		endpoints = []struct{ env, val string }{
			{oidcAuthURLEnv, authURL},
			{oidcTokenURLEnv, tokenURL},
			{oidcUserinfoURLEnv, userinfoURL},
		}
	}
	var missing []string
	for _, c := range append(required, endpoints...) {
		switch {
		case c.val != "":
		case c.env == oidcIssuerEnv:
			missing = append(missing, issuerOrURLs)
		default:
			missing = append(missing, c.env)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("partial OIDC configuration (missing: %s)", strings.Join(missing, "; "))
	}

	for _, c := range endpoints {
		if err := envflag.AbsoluteURL(c.val); err != nil {
			return nil, fmt.Errorf("%s: %w", c.env, err)
		}
	}

	name := envflag.Get(oidcNameEnv)
	if name == "" {
		name = "OIDC"
	}

	return &Config{
		ClientID:     clientID,
		ClientSecret: secret,
		Issuer:       issuer,
		AuthURL:      authURL,
		TokenURL:     tokenURL,
		UserinfoURL:  userinfoURL,
		DisplayName:  name,
	}, nil
}

// Apply makes the accounts collection's OAuth2 config match env, FromEnv's
// result (nil: OIDC off). It writes nothing when nothing changed ([D-65]).
// With OIDC on, the OIDC provider row is replaced wholesale and other
// providers are kept; with it off, OAuth2 is switched off as a whole and the
// rows are kept for switching back on.
func Apply(app core.App, env *Config) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return fmt.Errorf("Apply: accounts collection not found: %w", err)
	}
	if env == nil {
		if !col.OAuth2.Enabled {
			return nil
		}
		col.OAuth2.Enabled = false
		return app.Save(col)
	}

	var stored *core.OAuth2ProviderConfig
	i := slices.IndexFunc(col.OAuth2.Providers, func(p core.OAuth2ProviderConfig) bool { return p.Name == oidcProviderName })
	if i >= 0 {
		stored = &col.OAuth2.Providers[i]
	}
	ep, err := endpointsFor(env, stored)
	if err != nil {
		return err
	}

	want := core.OAuth2ProviderConfig{
		Name:         oidcProviderName,
		ClientId:     env.ClientID,
		ClientSecret: env.ClientSecret,
		AuthURL:      ep.AuthURL,
		TokenURL:     ep.TokenURL,
		UserInfoURL:  ep.UserinfoURL,
		DisplayName:  env.DisplayName,
	}
	if env.Issuer != "" {
		want.Extra = map[string]any{issuerExtraKey: issuerOf(env.Issuer)}
	}

	// Field-wise comparison: the struct carries Extra map[string]any and so
	// is not comparable with !=.
	sameConfig := stored != nil && stored.ClientId == want.ClientId &&
		stored.ClientSecret == want.ClientSecret && stored.AuthURL == want.AuthURL &&
		stored.TokenURL == want.TokenURL && stored.UserInfoURL == want.UserInfoURL &&
		stored.DisplayName == want.DisplayName && storedIssuer(stored) == storedIssuer(&want)
	if col.OAuth2.Enabled && sameConfig {
		return nil
	}
	col.OAuth2.Enabled = true
	if stored != nil {
		*stored = want
	} else {
		col.OAuth2.Providers = append(col.OAuth2.Providers, want)
	}
	// MappedFields is deliberately not seeded: the auto-create hook
	// (hooks.go) maps the name, because PocketBase's own create would run as
	// the anonymous visitor and be refused by accounts.CreateRule.
	return app.Save(col)
}

// endpointsFor returns the provider's three URLs, from the variables or the
// issuer's discovery document. When the document cannot be fetched, URLs an
// earlier boot discovered from the same issuer are used, so a provider that is
// down does not stop the app (passkeys included) from starting; with nothing
// stored the boot fails ([D-61]). A document that arrives but is wrong always
// fails it.
func endpointsFor(env *Config, stored *core.OAuth2ProviderConfig) (oidcEndpoints, error) {
	if env.Issuer == "" {
		return oidcEndpoints{AuthURL: env.AuthURL, TokenURL: env.TokenURL, UserinfoURL: env.UserinfoURL}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ep, err := discover(ctx, env.Issuer)
	if err == nil {
		return ep, nil
	}
	if _, unreachable := errors.AsType[fetchError](err); unreachable && stored != nil &&
		storedIssuer(stored) == issuerOf(env.Issuer) && stored.AuthURL != "" {
		log.Printf("shoppinglist: WARNING OIDC discovery failed (%v); using the endpoints discovered on an earlier start", err)
		return oidcEndpoints{AuthURL: stored.AuthURL, TokenURL: stored.TokenURL, UserinfoURL: stored.UserInfoURL}, nil
	}
	return oidcEndpoints{}, fmt.Errorf("%s: %w", oidcIssuerEnv, err)
}

// storedIssuer is the issuer a provider row's URLs were discovered from; ""
// for URLs that came from the variables.
func storedIssuer(p *core.OAuth2ProviderConfig) string {
	v, _ := p.Extra[issuerExtraKey].(string)
	return v
}
