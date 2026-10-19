package sync

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// snapshotResponse is one list's rows, in the shape PocketBase's records API
// serializes them (core.Record's JSON), so the client normalizes them with the
// same code as any record it reads from PocketBase.
type snapshotResponse struct {
	Items      []*core.Record `json:"items"`
	Categories []*core.Record `json:"categories"`
}

// snapshotIDs is the list's id set, tombstones included: what a client asks
// before the full snapshot, to drop the rows the server swept ([D-40]).
type snapshotIDs struct {
	Items      []string `json:"items"`
	Categories []string `json:"categories"`
}

// snapshotHandler implements GET /api/sync/snapshot/{listId}[?since=…|?ids]
// (§8.5, [D-173]): every items and list_categories row of the list,
// tombstones included, or with `since` only rows updated after it, or with
// `ids` only every row's id ([D-40]).
//
// A custom route rather than the collection API, whose rules answer a
// rejected token with 200-and-empty: the client's sweep drops every row the
// snapshot omits, so that would empty the local mirror. Here a 200 with no
// rows can only mean the list is empty ([D-74]).
func snapshotHandler(e *core.RequestEvent) error {
	listID := e.Request.PathValue("listId")
	if e.Request.URL.Query().Has("ids") {
		return snapshotIDsHandler(e, listID)
	}
	since := e.Request.URL.Query().Get("since")

	var newer dbx.Expression // FindAllRecords skips a nil one
	if since != "" {
		newer = dbx.NewExp("updated > {:since}", dbx.Params{"since": since})
	}

	items, err := e.App.FindAllRecords(collectionItems, dbx.HashExp{"list": listID}, newer)
	if err != nil {
		return e.InternalServerError("failed to fetch items", err)
	}
	categories, err := e.App.FindAllRecords(collectionCategories, dbx.HashExp{"list": listID}, newer)
	if err != nil {
		return e.InternalServerError("failed to fetch categories", err)
	}

	return e.JSON(http.StatusOK, snapshotResponse{Items: items, Categories: categories})
}

// snapshotIDsHandler answers `?ids`: one indexed column per table, never
// whole records.
func snapshotIDsHandler(e *core.RequestEvent, listID string) error {
	ids := snapshotIDs{Items: []string{}, Categories: []string{}}
	for table, into := range map[string]*[]string{collectionItems: &ids.Items, collectionCategories: &ids.Categories} {
		if err := e.App.DB().Select("id").From(table).Where(dbx.HashExp{"list": listID}).Column(into); err != nil {
			return e.InternalServerError("failed to fetch ids", err)
		}
	}
	return e.JSON(http.StatusOK, ids)
}
