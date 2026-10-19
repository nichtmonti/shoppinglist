// Migration 1778000017 — settings names the identity an OIDC login is
// connected as ([D-76]).
//
// `oidc_identities` holds the label settings shows — the provider's
// preferred_username, else the address it asserted — one row per account,
// written by the OIDC login hook (internal/oidc) and read by GET
// /api/auth/methods. Its own collection rather than an `accounts` column: the
// accounts record travels in every auth response and is persisted in the
// client's auth store, and the §11 accounts update guard would refuse the
// hook's write. No rules: server only, never served to co-members.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	pbmigrations.Register(oidcIdentitiesUp, oidcIdentitiesDown, "1778000017_oidc_identities.go")
}

func oidcIdentitiesUp(app core.App) error {
	accounts, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	identities := core.NewBaseCollection("oidc_identities")
	identities.Fields.Add(
		&core.RelationField{Name: "account", Required: true, MaxSelect: 1, CollectionId: accounts.Id, CascadeDelete: true},
		&core.TextField{Name: "label"},
	)
	identities.Indexes = types.JSONArray[string]{"CREATE UNIQUE INDEX `idx_oidc_identities_account` ON `oidc_identities` (`account`)"}
	// all rules nil (server-managed, never exposed to clients)
	addTimestamps(identities)
	return app.Save(identities)
}

func oidcIdentitiesDown(app core.App) error {
	identities, err := app.FindCollectionByNameOrId("oidc_identities")
	if err != nil {
		return nil // never created
	}
	return app.Delete(identities)
}
