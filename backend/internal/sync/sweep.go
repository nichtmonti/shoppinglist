package sync

import (
	"errors"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// horizon is how long a tombstone and a [D-108] merge-log row outlive the
// write that made them (§13). No cursor depends on it (§8.5), so it only has
// to cover a realistic offline gap; a merge-log row expired too early lets a
// retried create re-run the merge and un-check someone's purchase.
const horizon = "-180 days"

// SweepTombstones hard-deletes tombstoned items and list_categories past the
// horizon. Spared regardless of age: an item with a last_bought_at, which IS
// the "Frühere Artikel" entry §6.10 never GCs, and a category with a slug,
// which is how the missing-categories route knows a member removed that
// template's aisle ([D-251]).
func SweepTombstones(app core.App) error {
	return errors.Join(
		sweep(app, `DELETE FROM items WHERE deleted_at != '' AND deleted_at < datetime('now', {:horizon}) `+
			`AND last_bought_at = ''`),
		sweep(app, `DELETE FROM list_categories WHERE deleted_at != '' AND deleted_at < datetime('now', {:horizon}) `+
			`AND slug = ''`),
	)
}

// SweepMergeLog drops merge-log rows past the horizon.
func SweepMergeLog(app core.App) error {
	return sweep(app, `DELETE FROM merge_log WHERE merged_at != '' AND merged_at < datetime('now', {:horizon})`)
}

func sweep(app core.App, query string) error {
	_, err := app.DB().NewQuery(query).Bind(dbx.Params{"horizon": horizon}).Execute()
	return err
}
