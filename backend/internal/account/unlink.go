// The [D-76] unlink route: remove the caller's OIDC login, keeping the
// account, the reverse of the §5.9 link ([D-76]).

package account

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/oidclogin"
	"shoppinglist/internal/security"
)

// unlinkOidc handles POST /api/account/unlink ([D-76]).
//
// It refuses (409) unless the account keeps a way in (waysIn): passkeys on
// for the instance AND at least one on the account, the mirror of the §5.4
// guard ([D-32], [D-76]). The count and the delete share one transaction, so this
// and a concurrent delete of the last passkey cannot both pass. Issued
// sessions stay valid.
//
// 404 while the instance's OIDC login is off.
func unlinkOidc(passkeys bool) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if _, on := oidclogin.Live(e.App); !on {
			return e.NotFoundError("", nil)
		}
		if !passkeys {
			return e.Error(http.StatusConflict, "passkeys are off on this instance; the OIDC login is the only way in", nil)
		}
		err := e.App.RunInTransaction(func(tx core.App) error {
			n, has, err := waysIn(tx, e.Auth, passkeys)
			if err != nil {
				return err
			}
			if n == 0 {
				return e.Error(http.StatusConflict, "add a passkey first; the OIDC login is this account's only way in", nil)
			}
			if !has {
				return e.NotFoundError("this account has no OIDC login", nil)
			}
			if err := tx.DeleteAllExternalAuthsByRecord(e.Auth); err != nil {
				return err
			}
			return oidclogin.SetIdentity(tx, e.Auth.Id, "")
		})
		if err != nil {
			return security.RefusalOr500(e, "failed to remove the OIDC login", err)
		}
		return e.JSON(http.StatusOK, map[string]any{"ok": true})
	}
}
