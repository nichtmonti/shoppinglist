// Package webauthn wires the four §5.4 passkey routes around the go-webauthn
// library (we write zero crypto, §5.1): the Relying-Party config (§5.7), the
// webauthn.User adapter for accounts and the in-memory ceremony store (§5.5).
package webauthn

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"shoppinglist/internal/bootenv"
	"shoppinglist/internal/settings"
	"shoppinglist/internal/signup"
)

// Config holds the validated Relying-Party settings (§5.7) plus the signup
// mode.
type Config struct {
	// Enabled is SHOPPINGLIST_PASSKEYS ([D-76]). Off, the routes are not
	// registered and no RP-ID is needed; RPOrigin still names the app's
	// origin, from SHOPPINGLIST_RP_ORIGIN or else SHOPPINGLIST_APP_URL.
	Enabled bool

	RPID          string
	RPDisplayName string
	RPOrigin      string

	// Signup is SHOPPINGLIST_SIGNUP: who may mint a NEW account ([D-241]).
	Signup signup.Mode
}

// rpDocs is where an operator reads how to set the RP-ID and origin.
const rpDocs = "docs/deploy-reference.md#getting-rp-id-and-rp-origin-right"

const (
	envRPID     = settings.RPIDEnv
	envRPOrigin = settings.RPOriginEnv
	envAppURL   = settings.AppURLEnv
	// PasskeysEnv switches passkey login on or off ([D-76]).
	PasskeysEnv = settings.PasskeysEnv
)

// FromSettings validates the Relying-Party settings. Its errors are fatal at
// boot: with passkeys on an RP-ID that is unset or a raw IP (passkeys break on
// either, §5.7), with passkeys off no origin, and an RP_ORIGIN that is not an
// origin.
func FromSettings(s settings.Serve, b settings.Boot) (*Config, error) {
	// Default on: passkeys are the app's own login, and an instance must not
	// lose them by omission.
	enabled := bool(s.Passkeys)
	signupMode, err := signup.ParseMode(s.Signup)
	if err != nil {
		return nil, err
	}
	if !enabled {
		origin := s.RPOrigin
		if origin != "" {
			if origin, err = checkOrigin(origin, ""); err != nil {
				return nil, err
			}
		}
		if origin == "" {
			origin = b.AppURL
		}
		origin = strings.TrimRight(origin, "/")
		if origin == "" {
			return nil, fmt.Errorf("%s=off needs the app's origin from %s or %s (CORS and the first-boot installer URL use it)",
				PasskeysEnv, envRPOrigin, envAppURL)
		}
		return &Config{Enabled: false, RPOrigin: origin, Signup: signupMode}, nil
	}

	rpid := s.RPID
	if rpid == "" {
		return nil, fmt.Errorf("%s is not set — passkeys require the domain users open, such as list.example.com (%s)", envRPID, rpDocs)
	}
	if ip := net.ParseIP(rpid); ip != nil {
		return nil, fmt.Errorf("%s (%q) is a raw IP — passkeys require a domain name (%s)", envRPID, rpid, rpDocs)
	}
	// go-webauthn's own refusal names neither the setting nor the fix.
	if strings.ContainsAny(rpid, ":/ ") {
		return nil, fmt.Errorf("%s (%q) must be a bare domain such as list.example.com, without https://, a port or a path (%s)",
			envRPID, rpid, rpDocs)
	}
	origin := s.RPOrigin
	if origin == "" {
		origin = "https://" + rpid
	} else if origin, err = checkOrigin(origin, rpid); err != nil {
		return nil, err
	}
	return &Config{Enabled: true, RPID: rpid, RPDisplayName: bootenv.AppName, RPOrigin: origin, Signup: signupMode}, nil
}

// checkOrigin refuses an SHOPPINGLIST_RP_ORIGIN that cannot be the address
// bar's origin: go-webauthn compares it as a string, so a malformed one fails
// every ceremony with nothing in the log naming the setting (§5.7). With rpid
// set it also checks what the browser will (RP-ID a parent of the host, https
// outside localhost). It returns the origin as the browser serializes it.
func checkOrigin(origin, rpid string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil ||
		strings.TrimRight(u.Path, "/") != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%s must be an origin like https://list.example.com (scheme, host and an optional port, nothing after), got %q",
			envRPOrigin, origin)
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname())
	norm := scheme + "://" + strings.ToLower(u.Host)
	if p := u.Port(); (scheme == "https" && p == "443") || (scheme == "http" && p == "80") {
		norm = scheme + "://" + strings.ToLower(strings.TrimSuffix(u.Host, ":"+p))
	}
	if rpid == "" {
		return norm, nil
	}
	id := strings.ToLower(strings.TrimSuffix(rpid, "."))
	if host != id && !strings.HasSuffix(host, "."+id) {
		return "", fmt.Errorf("%s (%q) is not on %s (%q): browsers refuse every passkey unless the RP-ID is the origin's host or a parent domain of it",
			envRPOrigin, origin, envRPID, rpid)
	}
	if scheme == "http" && host != "localhost" && !strings.HasSuffix(host, ".localhost") {
		return "", fmt.Errorf("%s (%q) is plain http: browsers offer passkeys only over https (or on localhost)", envRPOrigin, origin)
	}
	return norm, nil
}

// New builds the go-webauthn instance, requiring discoverable keys and user
// verification (§5.3).
func New(cfg *Config) (*webauthn.WebAuthn, error) {
	if cfg == nil {
		return nil, errors.New("nil webauthn config")
	}
	return webauthn.New(&webauthn.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPDisplayName,
		RPOrigins:     []string{cfg.RPOrigin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		},
		// Some authenticators return extension outputs unprompted, which
		// go-webauthn would fail by default ([D-201]).
		ExtensionsUnsolicitedOutputPolicy: protocol.UnsolicitedOutputPolicyIgnore,
	})
}
