// Package oidclogin answers the questions about the instance's OIDC login
// that internal/oidc and internal/account must agree on ([D-76]): does the
// login work now, does an account have one, and which identity is it
// ([D-76])? It is its own package because internal/oidc's tests import
// internal/account, which would otherwise import internal/oidc back.
package oidclogin

import (
	"slices"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/records"
)

// ProviderName is the OAuth2 provider the SHOPPINGLIST_OIDC_* variables
// configure: PocketBase's generic OpenID Connect provider (tools/auth:
// NameOIDC).
const ProviderName = "oidc"

// Live reports the instance's OIDC login while OAuth2 is enabled on the
// accounts collection with the ProviderName row, which oidc.Apply keeps
// matching the environment; it reads the collection because PocketBase's
// auth-with-oauth2 route acts on it. `name` is the display label.
func Live(app core.App) (name string, ok bool) {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil || !col.IsAuth() || !col.OAuth2.Enabled {
		return "", false
	}
	i := slices.IndexFunc(col.OAuth2.Providers, func(p core.OAuth2ProviderConfig) bool { return p.Name == ProviderName })
	if i < 0 {
		return "", false
	}
	if name = col.OAuth2.Providers[i].DisplayName; name == "" {
		name = ProviderName
	}
	return name, true
}

// HasLogin reports whether acct has an OIDC login: an ExternalAuth row, which
// is the only record of one, since the app stores no emails ([D-25]).
func HasLogin(app core.App, acct *core.Record) (bool, error) {
	logins, err := app.FindAllExternalAuthsByRecord(acct)
	return len(logins) > 0, err
}

// identitiesCollection holds the label settings shows for an account's OIDC
// login (migration 1778000017, [D-76]): server only, one row per account.
const identitiesCollection = "oidc_identities"

// MaxIdentityBytes caps a stored label, sized like the nickname cap ([D-08]).
// The label comes from the provider, so an over-long one is cut, not refused.
const MaxIdentityBytes = 200

// Identity returns the label stored for accountID's OIDC login, or "" when
// there is none.
func Identity(app core.App, accountID string) (string, error) {
	rec, err := records.FindFirstOptional(app, identitiesCollection, dbx.HashExp{"account": accountID})
	if rec == nil {
		return "", err
	}
	return rec.GetString("label"), nil
}

// SetIdentity stores label for accountID, replacing any earlier one; an empty
// label removes the row, so a provider that stopped sending a username and an
// address leaves no stale name behind.
func SetIdentity(app core.App, accountID, label string) error {
	rec, err := records.FindFirstOptional(app, identitiesCollection, dbx.HashExp{"account": accountID})
	if err != nil {
		return err
	}
	if label == "" {
		if rec == nil {
			return nil
		}
		return app.Delete(rec)
	}
	if rec == nil {
		col, err := app.FindCachedCollectionByNameOrId(identitiesCollection)
		if err != nil {
			return err
		}
		rec = core.NewRecord(col)
		rec.Set("account", accountID)
	} else if rec.GetString("label") == label {
		return nil
	}
	rec.Set("label", label)
	return app.Save(rec)
}
