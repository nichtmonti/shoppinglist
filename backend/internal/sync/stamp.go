package sync

import (
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/normalize"
)

// Register binds the sync collections' record hooks.
func Register(app core.App) {
	app.OnRecordUpdateExecute(collectionItems, collectionCategories).BindFunc(func(e *core.RecordEvent) error {
		e.Record.SetRaw("updated", nextStamp(e.Record.GetDateTime("updated"), time.Now()))
		return e.Next()
	})
	// name_norm, the [D-29] merge key, follows the name on every save through
	// the record pipeline (push, import and clone, the superuser dashboard).
	// The item's other derived column, image_url, is barcode.Register's.
	stampNorm := func(e *core.RecordEvent) error {
		e.Record.Set("name_norm", normalize.Name(e.Record.GetString("name")))
		return e.Next()
	}
	app.OnRecordCreateExecute(collectionItems).BindFunc(stampNorm)
	app.OnRecordUpdateExecute(collectionItems).BindFunc(stampNorm)
}

// nextStamp is a write's `updated`: the clock's millisecond, or one past the
// row's last stamp when the clock has not moved beyond it. The §8.5 digest
// hashes id:updated, and PocketBase stamps whole milliseconds: two writes to
// one row in the same millisecond (one member's check-off, another's removal)
// changed the row but not its hash, so a device holding the first version
// never pulled the second ([D-40]). A stamp set here differs from the stored
// one, so PocketBase's own autodate keeps it.
func nextStamp(prev types.DateTime, now time.Time) types.DateTime {
	at := now.UTC().Truncate(time.Millisecond)
	if last := prev.Time(); !prev.IsZero() && !at.After(last) {
		at = last.Add(time.Millisecond)
	}
	stamp, _ := types.ParseDateTime(at)
	return stamp
}

// NextStampSQL is nextStamp for a raw UPDATE of items or list_categories,
// which no hook sees: the new `updated`, given the clock's stamp as {:now}.
const NextStampSQL = `CASE WHEN updated >= {:now}
	THEN strftime('%Y-%m-%d %H:%M:%f', substr(updated, 1, 23), '+0.001 seconds') || 'Z'
	ELSE {:now} END`
