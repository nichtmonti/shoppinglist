// Migration 1778000015 — memberships gets an index on `list` alone.
//
// Three hot reads ask for a list's memberships without an account: the §7.3
// last-one-out cascade's count on every departure, the §7.4 roster, and the
// invite preview's member count. The unique (account, list) index's leading
// column cannot serve them, so without this each is a full scan of the table.
// Index-only change — no backfill, nothing for clients to re-pull.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(membershipsListUp, membershipsListDown, "1778000015_memberships_list_index.go")
}

const membershipsListIndex = "idx_memberships_list"

func membershipsListUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("memberships")
	if err != nil {
		return err
	}
	col.Indexes = append(col.Indexes, "CREATE INDEX `"+membershipsListIndex+"` ON `memberships` (`list`)")
	return app.Save(col)
}

func membershipsListDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("memberships")
	if err != nil {
		return err
	}
	col.RemoveIndex(membershipsListIndex)
	return app.Save(col)
}
