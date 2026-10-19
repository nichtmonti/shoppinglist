// Migration 1778000009 — the §8.5 digest's list_categories half, made indexed.
//
// digest.go selects `id, updated FROM list_categories WHERE list = ?` once per
// membership per sync cycle (~60s per device, docs/internals/design.md §8.5), and the same
// `list = ?` shape serves the membership cascade's delete and the list clone's
// copy. The items half lands on idx_items_list_name_norm (1778000008); this
// gives the categories query an index too, instead of a full SCAN per list
// per cycle.
//
// Plain non-unique index on `list`: rows are per-list children, the digest
// only reads two columns, and uniqueness constraints live elsewhere (none of
// the existing indexes cover `list` alone). Index-only change — no backfill,
// no `updated` bumps, nothing for clients to re-pull.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(listCategoriesListUp, listCategoriesListDown, "1778000009_list_categories_list_index.go")
}

const listCategoriesListIndex = "idx_list_categories_list"

func listCategoriesListUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("list_categories")
	if err != nil {
		return err
	}
	col.Indexes = append(col.Indexes, "CREATE INDEX `"+listCategoriesListIndex+"` ON `list_categories` (`list`)")
	return app.Save(col)
}

func listCategoriesListDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("list_categories")
	if err != nil {
		return err
	}
	col.RemoveIndex(listCategoriesListIndex)
	return app.Save(col)
}
