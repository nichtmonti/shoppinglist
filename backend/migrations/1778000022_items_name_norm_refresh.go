// Migration 1778000022 — name_norm made true for every existing item
// ([D-29], [D-266]).
//
// Since the items save hook (internal/sync's Register) every write sets
// name_norm, the superuser dashboard's included. A row the dashboard wrote or
// renamed before that kept an empty or stale one, and the duplicate-create and
// restore merges look a twin up by it: such a row was never found. This
// recomputes it where it differs from normalize.Name(name), once.
//
// `updated` moves on each row it fixes, as in 1778000008: name_norm never
// reaches a client, but the digest guard (divergence_guard_test.go) holds every
// raw UPDATE of a digested table to it, and the cost is one re-pull of those
// rows. Down is a no-op; the old values were wrong.

package migrations

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/normalize"
)

func init() {
	pbmigrations.Register(nameNormRefreshUp, func(core.App) error { return nil }, "1778000022_items_name_norm_refresh.go")
}

func nameNormRefreshUp(app core.App) error {
	type nameRow struct {
		Id       string `db:"id"`
		Name     string `db:"name"`
		NameNorm string `db:"name_norm"`
	}
	var rows []nameRow
	if err := app.DB().NewQuery("SELECT id, name, name_norm FROM items").All(&rows); err != nil {
		return err
	}
	now := types.NowDateTime().String()
	for _, r := range rows {
		norm := normalize.Name(r.Name)
		if norm == r.NameNorm {
			continue
		}
		if _, err := app.DB().NewQuery("UPDATE items SET name_norm = {:norm}, updated = {:now} WHERE id = {:id}").
			Bind(dbx.Params{"norm": norm, "id": r.Id, "now": now}).Execute(); err != nil {
			return err
		}
	}
	return nil
}
