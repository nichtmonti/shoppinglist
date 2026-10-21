package account

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/security"
)

// Options is what the routes and guards need to know about the instance:
// whether passkeys ([D-76]) are a way in.
type Options struct {
	Passkeys bool
}

// RegisterRoutes mounts this package's custom routes on the serve router.
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent], opts Options) {
	auth := security.AuthRoutes(router)
	// The four lifecycle routes share ONE budget, so an abuser cannot get
	// four times the attempts by rotating between them.
	write := security.RateLimit(security.RateAccountWrite)
	auth.POST("/api/account/delete", deleteAccount(opts.Passkeys)).BindFunc(write)
	auth.POST("/api/account/rotate-token-key", rotateTokenKey).BindFunc(write)
	auth.POST("/api/account/link", linkAccount).BindFunc(write)
	auth.POST("/api/account/unlink", unlinkOidc(opts.Passkeys)).BindFunc(write)
	auth.POST("/api/credentials/{id}/rename", renameCredential).
		BindFunc(security.RateLimit(security.RateCredRename))
}

// deleteAccount handles POST /api/account/delete (§4.5, [D-32]), after a
// fresh sign-in ([D-309]).
func deleteAccount(passkeys bool) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if err := requireFreshSignIn(e, passkeys); err != nil {
			return err
		}
		if err := DeleteAccount(e.Request.Context(), e.App, e.Auth); err != nil {
			return e.InternalServerError("failed to delete account", err)
		}
		return e.JSON(http.StatusOK, map[string]any{"ok": true})
	}
}

// DeleteAccount is the one account teardown, shared by the §4.5 route, the
// §13 orphan sweep and the link: leave every list, delete the credentials,
// then the accounts row.
//
// One transaction, which the §7.3 cascade runs inside: a failure partway
// leaves the account as it was.
func DeleteAccount(ctx context.Context, app core.App, acct *core.Record) error {
	return app.RunInTransaction(func(tx core.App) error {
		// Memberships through the normal pipeline, so the §7.3 last-one-out
		// cascade hook fires per list. Credentials explicitly, with the
		// bypass: PocketBase's relation cascade cannot carry the bypass
		// context, so the guard would refuse the last passkey and roll the
		// whole delete back.
		if err := deleteEach(ctx, tx, "memberships", acct.Id); err != nil {
			return err
		}
		if err := deleteEach(bypassCredentialGuard(ctx), tx, "credentials", acct.Id); err != nil {
			return err
		}

		if err := tx.DeleteWithContext(ctx, acct); err != nil {
			return fmt.Errorf("delete account: %w", err)
		}
		return nil
	})
}

// SweepOrphans deletes accounts that have zero memberships, were created more
// than 60 days ago, and show no credential use within the last 60 days (§13).
// It goes through DeleteAccount: a plain app.Delete would trip the
// last-credential guard and roll the whole delete back. An account that fails
// does not stop the others; every failure is returned, joined. The deletions
// are logged, so an operator can answer why an account is gone.
func SweepOrphans(app core.App) error {
	var accounts []*core.Record
	err := app.RecordQuery("accounts").AndWhere(dbx.NewExp(
		`created != '' AND created < datetime('now','-60 days') ` +
			`AND id NOT IN (SELECT account FROM memberships) ` +
			`AND id NOT IN (SELECT account FROM credentials WHERE last_used_at != '' AND last_used_at >= datetime('now','-60 days'))`,
	)).All(&accounts)
	if err != nil {
		return err
	}
	var errs []error
	for _, acct := range accounts {
		if err := DeleteAccount(context.Background(), app, acct); err != nil {
			errs = append(errs, fmt.Errorf("account %s: %w", acct.Id, err))
		}
	}
	if deleted := len(accounts) - len(errs); deleted > 0 {
		applog.Info(app, "deleted accounts on no list and unused for 60 days", "count", deleted)
	}
	return errors.Join(errs...)
}

// deleteEach deletes the account's rows of `collection` one by one, under ctx.
func deleteEach(ctx context.Context, tx core.App, collection, accountID string) error {
	rows, err := tx.FindAllRecords(collection, dbx.HashExp{"account": accountID})
	if err != nil {
		return fmt.Errorf("load %s: %w", collection, err)
	}
	for _, r := range rows {
		if err := tx.DeleteWithContext(ctx, r); err != nil {
			return fmt.Errorf("delete from %s: %w", collection, err)
		}
	}
	return nil
}
