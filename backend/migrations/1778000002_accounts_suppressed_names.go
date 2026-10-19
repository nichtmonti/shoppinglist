package migrations

// docs/internals/design.md §6.11 [D-17]: suggestion suppression is "a global, per-account list
// of normalized names, stored on the account (a small JSON field on the accounts
// record)" and written through PocketBase's ordinary own-row path — never
// through sync/push. §11 names it alongside `nickname` as the second thing the
// accounts self-update allowlist admits.
//
// 1778000000 creates `accounts` without the field (the typeahead is its only
// consumer), so this migration adds it. The §11 allowlist hook
// (internal/account/guard.go) rejects a fixed set of protected columns and lets
// everything else through, so no hook change is needed for this field to be
// writable by its owner — and the collection's UpdateRule already restricts the
// row to `id = @request.auth.id`.

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(
		accountsSuppressedNamesUp,
		accountsSuppressedNamesDown,
		"1778000002_accounts_suppressed_names.go",
	)
}

func accountsSuppressedNamesUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	col.Fields.Add(&core.JSONField{Name: "suppressed_names", MaxSize: 65536})
	return app.Save(col)
}

func accountsSuppressedNamesDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("suppressed_names")
	return app.Save(col)
}
