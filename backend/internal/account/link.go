// The §5.9 [D-76] account-link route: attach the OIDC login the caller just
// signed in with to the caller's own account. It never merges two accounts
// ([D-76]).

package account

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/oidclogin"
	"shoppinglist/internal/security"
)

// linkAccount handles POST /api/account/link (§5.9, [D-76]).
//
// Authorization is valid credentials for both accounts: the caller A (via
// AuthRoutes) and, in the body's `token`, the OIDC account B the client just
// signed in as. That proves one person controls both.
//
//   - B empty (no memberships, no passkeys): B's ExternalAuth rows and
//     identity label move onto A, A is marked verified, B is deleted.
//   - B with lists or passkeys: 409; attaching would delete an account in use.
//   - A already has an OIDC login: 400.
//   - B has no OIDC login: 400.
//
// The emptiness check, the moves and B's deletion share one transaction, so B
// cannot gain a list or a passkey in between.
//
// 404 while the instance's OIDC login is off ([D-76]).
func linkAccount(e *core.RequestEvent) error {
	providerName, on := oidclogin.Live(e.App)
	if !on {
		return e.NotFoundError("", nil)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}
	if body.Token == "" {
		return e.BadRequestError("missing target token", nil)
	}

	caller := e.Auth
	target, err := e.App.FindAuthRecordByToken(body.Token, core.TokenTypeAuth)
	if err != nil {
		return e.UnauthorizedError("invalid target token", nil)
	}
	if target.Collection().Id != caller.Collection().Id {
		return e.BadRequestError("target token is not an accounts token", nil)
	}
	if target.Id == caller.Id {
		return e.BadRequestError("account is already linked to itself", nil)
	}

	err = e.App.RunInTransaction(func(tx core.App) error {
		if has, err := oidclogin.HasLogin(tx, caller); err != nil {
			return err
		} else if has {
			return e.BadRequestError("this account already has an OIDC login; remove it first", nil)
		}
		logins, err := tx.FindAllExternalAuthsByRecord(target)
		if err != nil {
			return err
		}
		if len(logins) == 0 {
			return e.BadRequestError("target account has no OIDC login", nil)
		}
		for _, owned := range []string{"memberships", "credentials"} {
			n, err := tx.CountRecords(owned, dbx.HashExp{"account": target.Id})
			if err != nil {
				return err
			}
			if n > 0 {
				return e.Error(http.StatusConflict,
					"this "+providerName+" login already belongs to another account with its own lists or passkeys; "+
						"sign in with it there, or share lists between the two accounts with an invite", nil)
			}
		}

		// Re-read inside the transaction, so the save below writes back
		// exactly what is stored apart from the flag.
		caller, err := tx.FindRecordById(caller.Collection(), caller.Id)
		if err != nil {
			return err
		}
		if !caller.Verified() {
			// PocketBase's OAuth2 sign-in treats an unverified account as
			// possibly pre-hijacked and marks it verified, a write the accounts
			// guard refuses, so every later provider sign-in would fail
			// (internal/oidc/hooks.go). Before the logins move: PocketBase's
			// own upgrade would delete them and rotate A's token key.
			caller.SetVerified(true)
			if err := tx.SaveWithContext(bypassAccountsUpdateGuard(e.Request.Context()), caller); err != nil {
				return err
			}
		}
		label, err := oidclogin.Identity(tx, target.Id)
		if err != nil {
			return err
		}
		for _, x := range logins {
			x.SetRecordRef(caller.Id)
			if err := tx.Save(x); err != nil {
				return err
			}
		}
		if err := oidclogin.SetIdentity(tx, caller.Id, label); err != nil {
			return err
		}
		return DeleteAccount(e.Request.Context(), tx, target)
	})
	if err != nil {
		return security.RefusalOr500(e, "failed to link the account", err)
	}

	return e.JSON(http.StatusOK, map[string]any{"ok": true})
}
