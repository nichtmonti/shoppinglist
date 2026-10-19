// Migration 1778000008 — [D-29] duplicate-name merge, made a lookup.
//
// The merge (internal/sync's mergeByNormalizedName) looks for an existing item
// with the same normalized name once per create op. Without an index that
// means hydrating and normalizing every item on the list — with
// max_ops_per_push = 500 and up to 2000 items per list, ~1M hydrations per
// request. So the normalized name is stored as a server-owned column
// (name_norm), indexed with the list, and the merge queries only the rows
// that carry the same one.
//
// name_norm is computed ONLY with the shared normalize.Name (trim → NFKC →
// lower → collapse whitespace, pinned by seed/normalization-vectors.json) and
// is deliberately absent from both client whitelists (frontend normalizeItem,
// backend itemRecordMap), so it never reaches the client schema.

package migrations

import (
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/normalize"
)

func init() {
	pbmigrations.Register(nameNormUp, nameNormDown, "1778000008_items_name_norm.go")
}

const nameNormIndex = "idx_items_list_name_norm"

func nameNormUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		return err
	}
	// NOT Required: the backfill populates existing rows after the column exists.
	col.Fields.Add(&core.TextField{Name: "name_norm"})
	// NON-unique on purpose: tombstoned rows and concurrent same-name inserts
	// must remain legal — the merge picks the oldest non-tombstoned survivor.
	col.Indexes = append(col.Indexes, "CREATE INDEX `"+nameNormIndex+"` ON `items` (`list`, `name_norm`)")
	if err := app.Save(col); err != nil {
		return err
	}

	// Backfill with a two-column SELECT and one UPDATE per row rather than
	// hydrating every record: normalization cannot be expressed in SQL, and
	// only the name is needed to compute it.
	type nameRow struct {
		Id   string `db:"id"`
		Name string `db:"name"`
	}
	var rows []nameRow
	if err := app.DB().NewQuery("SELECT id, name FROM items").All(&rows); err != nil {
		return err
	}
	// One shared timestamp for the whole backfill, mirroring clearhistory.go's
	// single-`now` idiom: `updated` is stamped by PocketBase on save, not by
	// SQLite, so a raw UPDATE sets it explicitly. Every backfilled row's digest
	// therefore moves, and members re-pull those rows once.
	now := types.NowDateTime().String()
	for _, r := range rows {
		if strings.TrimSpace(r.Name) == "" {
			continue
		}
		if _, err := app.DB().NewQuery(
			"UPDATE items SET name_norm = {:norm}, updated = {:now} WHERE id = {:id}",
		).Bind(dbx.Params{"norm": normalize.Name(r.Name), "id": r.Id, "now": now}).Execute(); err != nil {
			return err
		}
	}
	return nil
}

func nameNormDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("name_norm")
	col.RemoveIndex(nameNormIndex)
	return app.Save(col)
}
