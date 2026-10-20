// Package oidc owns the instance's OIDC login (§5.9, [D-76]): configuration
// and discovery (config.go, discovery.go), the first-sign-in hook (hooks.go),
// the stranded-accounts boot warning (logins.go), the sign-in failure log
// (failure_log.go), and GET /api/auth/methods ([D-76]).
//
// That endpoint reports whether passkeys are on and open for new accounts
// ([D-241]) and whether an OIDC login is configured. It is unauthenticated,
// since the signed-out AuthScreen renders from it; a signed-in caller also
// learns whether their account has an OIDC login, which gates settings'
// "Link with ‹provider›" entry.
package oidc

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/oidclogin"
	"shoppinglist/internal/security"
)

// Passkeys is the instance's passkey configuration as the methods endpoint
// reports it, passed in from webauthn.FromSettings.
type Passkeys struct {
	Enabled bool `json:"enabled"`
	// Signup reports whether a visitor may create a NEW account with a
	// passkey (SHOPPINGLIST_SIGNUP); false while passkeys are off. It says
	// nothing about OIDC, where the provider decides ([D-76]).
	Signup bool `json:"signup"`
	// SignupByLink reports whether a visitor holding an invite or setup link
	// may create one ([D-241]); false while passkeys are off.
	SignupByLink bool `json:"signup_by_link"`
}

// oidcStatus's Provider is what the client passes to authWithOAuth2, and Name
// the button's label.
type oidcStatus struct {
	Enabled  bool   `json:"enabled"`
	Provider string `json:"provider,omitempty"`
	Name     string `json:"name,omitempty"`
	// Linked is set only for a signed-in account that already has an OIDC
	// login.
	Linked bool `json:"linked,omitempty"`
	// Identity is what that login is connected as ([D-76]), set only
	// alongside Linked.
	Identity string `json:"identity,omitempty"`
}

type methodsResponse struct {
	Passkeys Passkeys   `json:"passkeys"`
	Oidc     oidcStatus `json:"oidc"`
}

// RegisterRoutes mounts GET /api/auth/methods. The sign-in failure log
// (LogOAuth2Failure) goes on the root router, around PocketBase's own route.
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent], passkeys Passkeys) {
	if !passkeys.Enabled {
		passkeys.Signup = false
		passkeys.SignupByLink = false
	}
	router.GET("/api/auth/methods", func(e *core.RequestEvent) error {
		res := methodsResponse{Passkeys: passkeys}
		if name, ok := oidclogin.Live(e.App); ok {
			linked, identity, err := oidcLoginOf(e)
			if err != nil {
				return e.InternalServerError("failed to look up the OIDC login", err)
			}
			res.Oidc = oidcStatus{Enabled: true, Provider: oidclogin.ProviderName, Name: name, Linked: linked, Identity: identity}
		}
		return e.JSON(http.StatusOK, res)
	})
}

// oidcLoginOf reports whether the caller is signed in to an account that has
// an OIDC login, and the identity stored for it. Signed-out callers and any
// other auth collection answer false.
func oidcLoginOf(e *core.RequestEvent) (linked bool, identity string, err error) {
	if !security.IsAccount(e) {
		return false, "", nil
	}
	has, err := oidclogin.HasLogin(e.App, e.Auth)
	if err != nil || !has {
		return false, "", err
	}
	if identity, err = oidclogin.Identity(e.App, e.Auth.Id); err != nil {
		return false, "", err
	}
	return true, identity, nil
}
