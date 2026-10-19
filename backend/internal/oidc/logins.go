package oidc

import (
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/applog"
)

// WarnStrandedAccounts logs, once per boot, how many accounts the configured
// login methods leave without a way in ([D-76]). A warning, not a boot
// failure: switching a method off is a deliberate operator choice that a
// refused boot would make impossible.
func WarnStrandedAccounts(app core.App, passkeys, oidc bool) error {
	switch {
	case passkeys && oidc:
		return nil
	case !passkeys:
		n, err := app.CountRecords("accounts", dbx.NewExp("id NOT IN (SELECT recordRef FROM "+core.CollectionNameExternalAuths+")"))
		if err != nil {
			return err
		}
		if n > 0 {
			applog.Warn(app, fmt.Sprintf("%d account(s) have no OIDC login and cannot sign in while "+
				"SHOPPINGLIST_PASSKEYS=off — link them to the provider from settings while passkeys are still on", n), nil)
		}
	default:
		n, err := app.CountRecords("accounts", dbx.NewExp("id NOT IN (SELECT account FROM credentials)"))
		if err != nil {
			return err
		}
		if n > 0 {
			applog.Warn(app, fmt.Sprintf("%d account(s) have no passkey and cannot sign in while "+
				"SHOPPINGLIST_OIDC is off — they can add one from settings while OIDC is still on", n), nil)
		}
	}
	return nil
}
