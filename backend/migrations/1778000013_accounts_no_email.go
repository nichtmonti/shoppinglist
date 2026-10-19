// Migration 1778000013 — [D-25]: the app stores no email addresses.
//
// An OIDC-born account created before this migration carries the
// provider-asserted email ([D-76]). Nothing reads it as a login — there is no
// email or OTP login — so the stored addresses are cleared; internal/oidc's
// hook writes none.
//
// The hook's pre-create commits in one transaction with PocketBase's
// ExternalAuth row, so a failed login leaves nothing behind. Rows an earlier
// failed login DID leave are removed here: no handle (OIDC-born), and no
// ExternalAuth, credential or membership (never signed into, so no token for
// it was ever issued).
//
// The `email` column itself stays: it is a system field of PocketBase auth
// collections and cannot be removed. It remains empty and, through the §11
// accounts guard, unwritable from the client.

package migrations

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(clearAccountEmails, func(core.App) error {
		return nil // the addresses are gone; there is nothing to restore
	}, "1778000013_accounts_no_email.go")
}

// clearAccountEmails is the migration's up step, named so a test can re-run it
// against rows it inserted after the migrated schema exists.
func clearAccountEmails(app core.App) error {
	orphans, err := app.FindAllRecords("accounts", dbx.NewExp(
		`(handle = '' OR handle IS NULL) AND
			id NOT IN (SELECT recordRef FROM _externalAuths) AND
			id NOT IN (SELECT account FROM credentials) AND
			id NOT IN (SELECT account FROM memberships)`))
	if err != nil {
		return err
	}
	for _, rec := range orphans {
		if err := app.Delete(rec); err != nil {
			return err
		}
	}
	_, err = app.DB().NewQuery("UPDATE accounts SET email = '' WHERE email != ''").Execute()
	return err
}
