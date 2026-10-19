// Migration 1778000007 — [D-31], §7.1: invites become server-owned.
//
// Three changes, and the order matters.
//
// CreateRule and UpdateRule go to nil, so no client can write an invite: the
// two fields the server RELIES on, `token_hash` (whose entropy only the server
// can guarantee) and `created_by` (an authorization input to §7.3's cascade),
// must not be client-asserted. Minting and revocation are routes
// (internal/invites/manage.go explains why).
//
// ListRule and ViewRule are deliberately UNTOUCHED: the share sheet reads the
// current link's expiry through the collection API, and a sha256 of 32 random
// bytes discloses nothing to the members who may already redeem it.
//
// Then the "one active link per list" invariant ([D-31]: the schema supports
// N, the app keeps one) becomes structural with a partial unique index, so
// two members resetting at once cannot leave two live links. Existing rows have to be
// collapsed BEFORE the index is added, or the CREATE INDEX fails on any list
// that currently carries more than one live invite; the newest survives, since
// that is the one the share sheet was displaying.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	pbmigrations.Register(invitesServerOnlyUp, invitesServerOnlyDown, "1778000007_invites_server_only.go")
}

const (
	inviteTokenIndex  = "idx_invites_token_hash" // #nosec G101 -- an index name, not a credential
	inviteActiveIndex = "idx_invites_one_active_per_list"
)

func invitesServerOnlyUp(app core.App) error {
	// Collapse first: keep the newest non-revoked invite per list, revoke the
	// rest. `created` is PocketBase's autodate, so it orders reliably; the id
	// tiebreak keeps the choice deterministic if two rows share a timestamp.
	if _, err := app.DB().NewQuery(`
		UPDATE invites SET revoked = 1
		WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY list ORDER BY created DESC, id DESC
				) AS rn
				FROM invites WHERE revoked = 0
			) WHERE rn > 1
		)`).Execute(); err != nil {
		return err
	}

	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		return err
	}
	// Go guard: registerManageRoutes (internal/invites/manage.go) gates both
	// routes with RequireListMembership, the membershipRule they replace.
	col.CreateRule = nil // server routes only (internal/invites/manage.go)
	col.UpdateRule = nil // ditto — revocation is a route now
	col.Indexes = types.JSONArray[string]{
		"CREATE UNIQUE INDEX `" + inviteTokenIndex + "` ON `invites` (`token_hash`)",
		"CREATE UNIQUE INDEX `" + inviteActiveIndex + "` ON `invites` (`list`) WHERE revoked = 0",
	}
	return app.Save(col)
}

func invitesServerOnlyDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		return err
	}
	col.CreateRule = new(membershipRule("list.id"))
	col.UpdateRule = new(membershipRule("list.id"))
	col.Indexes = types.JSONArray[string]{
		"CREATE UNIQUE INDEX `" + inviteTokenIndex + "` ON `invites` (`token_hash`)",
	}
	return app.Save(col)
}
