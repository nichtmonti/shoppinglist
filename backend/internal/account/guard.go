// Package account implements the §4.5/§5.4/§5.9/§11 account lifecycle, its
// guards and its routes:
//
//   - the §11 self-update allowlist on accounts;
//   - the §5.4 last-credential delete guard ([D-32]);
//   - the _externalAuths delete guard, leaving the [D-76] unlink as the only
//     way to remove an OIDC login;
//   - the account teardown (delete.go), sole holder of the credential-guard
//     bypass;
//   - the §5.6 token-key rotation (rotate.go) and the §5.9 [D-76] link
//     (link.go), sole holders of the accounts-guard bypass;
//   - the §5.4 passkey rename (rename_credential.go);
//   - the [D-309] sign-in time on every sign-in's token, which the delete
//     checks (fresh.go).
package account

import (
	"context"
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/oidclogin"
)

// Register binds the guard hooks and the [D-309] sign-in stamp. Run it after
// the migrations (from OnServe).
func Register(app core.App, opts Options) {
	app.OnRecordAuthRequest("accounts").BindFunc(stampAuthTime)
	app.OnRecordUpdate("accounts").BindFunc(accountsUpdateGuard)
	// Priority 100 runs inside the delete's transaction (opened at 99), so the
	// count and the delete are atomic: counted outside, two concurrent deletes
	// of the last two passkeys would both see two and both pass.
	app.OnRecordDeleteExecute("credentials").Bind(&hook.Handler[*core.RecordEvent]{
		Func:     credentialsDeleteGuard(opts.Passkeys),
		Priority: 100,
	})
	app.OnRecordDeleteRequest(core.CollectionNameExternalAuths).BindFunc(externalAuthsDeleteGuard)
}

// externalAuthsDeleteGuard refuses the record API's delete of an
// _externalAuths row for everyone but a superuser ([D-76]). PocketBase ships
// it owner-deletable, so an OIDC-only account could otherwise strip its only
// way in past every guard. A request hook fires for the HTTP route only, so
// PocketBase's own deletes are untouched.
func externalAuthsDeleteGuard(e *core.RecordRequestEvent) error {
	if e.HasSuperuserAuth() {
		return e.Next()
	}
	return e.ForbiddenError("remove the OIDC login from settings (POST /api/account/unlink)", nil)
}

// protectedAccountFields are the accounts columns that must NOT change via
// the direct client update path (§11, §4.2). Everything else passes, which is
// exactly the §11 allowlist: `nickname` and `suppressed_names` (§6.11).
var protectedAccountFields = []string{"handle", "email", "verified", "tokenKey"}

// accountsUpdateGuard enforces the §11 self-update allowlist, narrowing
// accounts.UpdateRule (`id = @request.auth.id`): a change to any
// protectedAccountFields entry is refused. nickname is also length-checked
// ([D-08]).
func accountsUpdateGuard(e *core.RecordEvent) error {
	if e.Context != nil && e.Context.Value(acctGuardBypassKey{}) != nil {
		return e.Next() // §5.6 token-key rotation route's own save — exempt
	}

	// [D-08] nickname is served to every co-member (§7.4); the contract's cap
	// bounds it here and on the SaveNoValidate signup path alike.
	orig := e.Record.Original()
	if nick := e.Record.GetString("nickname"); nick != orig.GetString("nickname") {
		if msg := fieldcontract.OverCap("accounts", "nickname", nick); msg != "" {
			return router.NewBadRequestError(msg, nil)
		}
	}

	for _, f := range protectedAccountFields {
		if e.Record.Get(f) != orig.Get(f) {
			return router.NewForbiddenError(fmt.Sprintf("field %q cannot be changed directly", f), nil)
		}
	}
	return e.Next()
}

// acctGuardBypassKey scopes the accounts update-guard bypass. Unexported, so
// only this package can mint a context that satisfies it ([D-32]). rotate.go
// writes `tokenKey` (§5.6) and link.go `verified` ([D-76]) with it.
type acctGuardBypassKey struct{}

// bypassAccountsUpdateGuard returns a context that makes accountsUpdateGuard
// skip its check. Used ONLY by rotate.go and link.go.
func bypassAccountsUpdateGuard(ctx context.Context) context.Context {
	return context.WithValue(ctx, acctGuardBypassKey{}, true)
}

// credGuardBypassKey scopes the last-credential guard bypass ([D-32]).
// Unexported, so only this package can construct a context that satisfies it.
type credGuardBypassKey struct{}

// bypassCredentialGuard returns a context that makes credentialsDeleteGuard
// skip its check. Used ONLY by DeleteAccount, whose account goes too.
func bypassCredentialGuard(ctx context.Context) context.Context {
	return context.WithValue(ctx, credGuardBypassKey{}, true)
}

// waysIn is what acct can sign in with now ([D-76]): its passkeys while they
// are on for the instance, and its OIDC login while the instance's is live. A
// row a switched-off method left behind opens nothing. The last-passkey guard,
// the unlink and the [D-309] fresh sign-in all ask it.
func waysIn(app core.App, acct *core.Record, passkeysOn bool) (passkeys int64, oidc bool, err error) {
	if passkeysOn {
		if passkeys, err = app.CountRecords("credentials", dbx.HashExp{"account": acct.Id}); err != nil {
			return 0, false, err
		}
	}
	if _, live := oidclogin.Live(app); live {
		oidc, err = oidclogin.HasLogin(app, acct)
	}
	return passkeys, oidc, err
}

// credentialsDeleteGuard implements the §5.4 last-credential guard ([D-32]),
// narrowing credentials.DeleteRule: refuse to delete a credential unless the
// account keeps a way in (waysIn), another passkey or an OIDC login ([D-25]).
func credentialsDeleteGuard(passkeysOn bool) func(e *core.RecordEvent) error {
	return func(e *core.RecordEvent) error {
		if e.Context != nil && e.Context.Value(credGuardBypassKey{}) != nil {
			return e.Next() // account-deletion route's internal teardown — exempt
		}
		// A model hook has no e.InternalServerError; a bare error would reach
		// the record API's client as its generic 400 ([D-191]).
		acct, err := e.App.FindRecordById("accounts", e.Record.GetString("account"))
		if err != nil {
			return router.NewInternalServerError("failed to load the account", err)
		}
		// The row being deleted still counts: this runs before the DELETE.
		passkeys, oidc, err := waysIn(e.App, acct, passkeysOn)
		if err != nil {
			return router.NewInternalServerError("failed to check the account's other logins", err)
		}
		if passkeys > 1 || oidc {
			return e.Next()
		}
		return router.NewForbiddenError("cannot delete the last passkey of an account without another login", nil)
	}
}
