// Migration 1778000006 — [D-76], §5.9: accounts.handle becomes unique-when-set
// in practice, not just by SQLite's NULL semantics.
//
// OIDC-born accounts (PocketBase's first-login auto-create, pre-created by
// internal/oidc's hook) carry NO handle, and PB materializes an unset text
// field as ” on save — the original index (1778000000) is a plain UNIQUE on
// the column, and SQLite's "multiple NULLs are fine" never comes into play:
// the second OIDC account's ” collides with the first's. The index becomes
// partial, excluding the empty string, so any number of handle-less accounts
// can coexist while real handles stay unique. Passkey accounts are unaffected
// — registration always generates a random handle.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	pbmigrations.Register(oidcHandleIndexUp, oidcHandleIndexDown, "1778000006_oidc_handle_index.go")
}

const handleIndex = "idx_accounts_handle"

func oidcHandleIndexUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	col.Indexes = types.JSONArray[string]{
		"CREATE UNIQUE INDEX `" + handleIndex + "` ON `accounts` (`handle`) WHERE handle != ''",
	}
	return app.Save(col)
}

func oidcHandleIndexDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	col.Indexes = types.JSONArray[string]{
		"CREATE UNIQUE INDEX `" + handleIndex + "` ON `accounts` (`handle`)",
	}
	return app.Save(col)
}
