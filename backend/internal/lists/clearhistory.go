package lists

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/sync"
)

// clearHistory handles POST /api/lists/{listId}/clear-history [D-79]: it nulls
// checked_at and last_bought_at across the list, tombstones included, and
// leaves checked untouched. On a removed-but-bought tombstone this is a
// deliberate PURGE ([D-100]). It must be a server route: both columns are
// server-stamped ([D-26], [D-45]), so no client op can clear them.
//
// ONE raw statement, not a record loop that hydrates every row. It does two
// things the record pipeline would have done:
//
//   - it sets `updated` itself (PocketBase stamps it on save, not the
//     database): the §8.5 digest hashes it, so without the bump nobody
//     would pull the cleared rows;
//   - a raw UPDATE broadcasts no realtime event, so touchOne sends one.
//
// The WHERE clause keeps `updated`, and so the re-pull, off rows nothing
// changed on, and makes the count report dates actually forgotten.
func clearHistory(e *core.RequestEvent) error {
	listID := e.Request.PathValue("listId")

	// A row stamped at or past the clock (the sync stamp hook moves a busy
	// row's `updated` a millisecond past the last one) moves one more, as the
	// hook would: an unchanged stamp leaves the digest blind to the clear.
	now := types.NowDateTime().String()
	res, err := e.App.DB().NewQuery(`
		UPDATE items
		SET checked_at = '', last_bought_at = '', prev_bought_at = '',
			updated = ` + sync.NextStampSQL + `
		WHERE list = {:list} AND (checked_at != '' OR last_bought_at != '')
	`).Bind(dbx.Params{"list": listID, "now": now}).Execute()
	if err != nil {
		return e.InternalServerError("failed to clear history", err)
	}
	cleared, err := res.RowsAffected()
	if err != nil {
		return e.InternalServerError("failed to clear history", err)
	}

	if cleared > 0 {
		touchOne(e.App, listID, now)
	}

	return e.JSON(http.StatusOK, map[string]int64{"cleared": cleared})
}

// touchOne re-saves one already-cleared row purely for its realtime
// broadcast; one event schedules every member's sync cycle. It matches on
// a stamp at or after the one the UPDATE wrote, so it never drags a row
// untouched since before the clear into the re-pull. Best-effort: a failure costs only promptness, as the digest
// still converges, so it never fails the request.
func touchOne(app core.App, listID, updatedAt string) {
	rec, err := app.FindFirstRecordByFilter("items",
		"list = {:list} && updated >= {:updated}",
		dbx.Params{"list": listID, "updated": updatedAt})
	if err != nil {
		return
	}
	_ = app.SaveNoValidate(rec)
}
