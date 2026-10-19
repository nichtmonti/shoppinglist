// Migration 1778000021 — a merge-log row names the op that made the merge
// ([D-108]).
//
// A restore-merge is logged under the tombstone's id, which every later
// restore of that row reuses: the log took a new restore for a retry of the
// old one and answered it with the old merge. The op id tells them apart. A row
// from before this migration has none and keeps answering as before.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(mergeLogOpIDUp, mergeLogOpIDDown, "1778000021_merge_log_op_id.go")
}

func mergeLogOpIDUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("merge_log")
	if err != nil {
		return err
	}
	col.Fields.Add(&core.TextField{Name: "op_id", Max: 64})
	return app.Save(col)
}

func mergeLogOpIDDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("merge_log")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("op_id")
	return app.Save(col)
}
