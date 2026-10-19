package oidc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"shoppinglist/internal/envflag"
)

// OIDC Discovery (OpenID Connect Discovery 1.0 §4): SHOPPINGLIST_OIDC_ISSUER
// replaces the three endpoint variables with the issuer's
// /.well-known/openid-configuration document.

const wellKnownPath = "/.well-known/openid-configuration"

// oidcEndpoints are the three URLs PocketBase's generic OIDC provider takes.
type oidcEndpoints struct {
	AuthURL     string
	TokenURL    string
	UserinfoURL string
}

// discoveryClient and discoveryRetryDelays are variables so tests can point
// discovery at an httptest server and skip the waits; proxyFor so they can
// fake HTTPS_PROXY, which net/http reads once per process.
var (
	discoveryClient      = &http.Client{Timeout: 10 * time.Second}
	discoveryRetryDelays = []time.Duration{time.Second, 3 * time.Second}
	proxyFor             = http.ProxyFromEnvironment
)

// discoveryURL is where the issuer's document lives. The variable may hold
// the issuer or the document's own address, since providers show both.
func discoveryURL(issuer string) string {
	if strings.HasSuffix(issuer, wellKnownPath) {
		return issuer
	}
	return strings.TrimSuffix(issuer, "/") + wellKnownPath
}

// issuerOf is the issuer a SHOPPINGLIST_OIDC_ISSUER value names, without the
// document path or a trailing slash, for comparison with the document's own.
func issuerOf(v string) string {
	return strings.TrimSuffix(strings.TrimSuffix(v, wellKnownPath), "/")
}

// discover fetches the issuer's discovery document, retrying a failed fetch
// (a provider starting alongside this server answers a moment later).
func discover(ctx context.Context, issuer string) (oidcEndpoints, error) {
	var lastErr error
	for attempt := 0; ; attempt++ {
		ep, err := fetchDiscovery(ctx, issuer)
		if err == nil {
			return ep, nil
		}
		lastErr = err
		if _, retryable := errors.AsType[fetchError](err); !retryable || attempt >= len(discoveryRetryDelays) {
			return oidcEndpoints{}, lastErr
		}
		select {
		case <-ctx.Done():
			return oidcEndpoints{}, lastErr
		case <-time.After(discoveryRetryDelays[attempt]):
		}
	}
}

// fetchError marks a failure worth retrying: the provider did not answer, or
// answered with an error status. A document that arrives but is wrong is not
// one — fetching it again returns the same document.
type fetchError struct{ error }

func fetchDiscovery(ctx context.Context, issuer string) (oidcEndpoints, error) {
	url := discoveryURL(issuer)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return oidcEndpoints{}, fmt.Errorf("%s: %w", oidcIssuerEnv, err)
	}
	res, err := discoveryClient.Do(req)
	if err != nil {
		return oidcEndpoints{}, fetchError{fmt.Errorf("fetching %s: %w%s", url, err, proxyHint(req))}
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return oidcEndpoints{}, fetchError{fmt.Errorf("fetching %s: HTTP %d", url, res.StatusCode)}
	}

	var doc struct {
		Issuer                string `json:"issuer"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserinfoEndpoint      string `json:"userinfo_endpoint"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		return oidcEndpoints{}, fmt.Errorf("%s is not a discovery document: %w", url, err)
	}
	// Discovery §4.3: the document's issuer MUST be the one it was fetched
	// for. A mismatch is a wrong URL (another realm, a proxy's own document),
	// and its endpoints would sign users in somewhere else.
	if issuerOf(doc.Issuer) != issuerOf(issuer) {
		return oidcEndpoints{}, fmt.Errorf("%s names issuer %q, not %q: check %s",
			url, doc.Issuer, issuerOf(issuer), oidcIssuerEnv)
	}
	ep := oidcEndpoints{
		AuthURL:     doc.AuthorizationEndpoint,
		TokenURL:    doc.TokenEndpoint,
		UserinfoURL: doc.UserinfoEndpoint,
	}
	for _, f := range []struct{ field, val string }{
		{"authorization_endpoint", ep.AuthURL},
		{"token_endpoint", ep.TokenURL},
		// Optional in the spec, but the app reads the user's name from it.
		{"userinfo_endpoint", ep.UserinfoURL},
	} {
		if f.val == "" {
			return oidcEndpoints{}, fmt.Errorf("%s has no %s: set %s, %s and %s instead of %s",
				url, f.field, oidcAuthURLEnv, oidcTokenURLEnv, oidcUserinfoURLEnv, oidcIssuerEnv)
		}
		if err := envflag.AbsoluteURL(f.val); err != nil {
			return oidcEndpoints{}, fmt.Errorf("%s %s: %w", url, f.field, err)
		}
	}
	return ep, nil
}

// proxyHint names the proxy a failed request went through: a refusal
// by an allowlisting proxy otherwise reads like the provider's answer.
func proxyHint(req *http.Request) string {
	proxy, err := proxyFor(req)
	if err != nil || proxy == nil {
		return ""
	}
	return fmt.Sprintf(" (through the proxy %s from HTTPS_PROXY — check that it allows %s; docs/deploy-reference.md#an-egress-allowlist)",
		proxy.Redacted(), req.URL.Host)
}
