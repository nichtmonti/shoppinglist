package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	pbmigrations.Register(createMergeLogUp, createMergeLogDown, "1778000010_create_merge_log.go")
}

// merge_log remembers the identity a [D-29] duplicate-name create GIVES UP when
// the server merges it into an existing row ([D-108]).
//
// The row id IS the discarded client-minted record id, which makes the replay
// lookup a primary-key hit on the one path that needs it (processCreate, once
// per create op, up to 500 per push). That is the whole reason this collection
// exists: [D-42]'s duplicate-record_id check asks `FindRecordById(collection,
// op.RecordID)` and a merged create's id was never stored anywhere, so a retry
// after a lost response looked like a brand-new create and re-ran the merge —
// re-activating a row another member had checked off in the meantime.
//
// Server-only: no API rules, so the collection is unreachable from a client
// token (the push route is the only writer, and it runs as the app). It carries
// no user content — two ids and a timestamp.
func createMergeLogUp(app core.App) error {
	c := core.NewBaseCollection("merge_log")
	c.Fields.Add(
		// The list the merge happened on. Not strictly needed to answer a
		// replay, but the §7.3 cascade has to be able to take these rows with
		// the list, and a per-list index is what makes that a cheap delete.
		&core.TextField{Name: "list", Required: true},
		// The row the create was merged INTO — what a replay must answer with.
		&core.TextField{Name: "survivor", Required: true},
		&core.DateField{Name: "merged_at", Required: true},
	)
	c.Indexes = types.JSONArray[string]{
		"CREATE INDEX `idx_merge_log_list` ON `merge_log` (`list`)",
		// The §13 sweep's horizon predicate.
		"CREATE INDEX `idx_merge_log_merged_at` ON `merge_log` (`merged_at`)",
	}
	return app.Save(c)
}

func createMergeLogDown(app core.App) error {
	c, err := app.FindCollectionByNameOrId("merge_log")
	if err != nil {
		return err
	}
	return app.Delete(c)
}
