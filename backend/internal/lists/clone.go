package lists

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/randid"
)

// cloneListBody carries only the copy's name, which is required. The new
// list's id is SERVER-minted ([D-08]).
type cloneListBody struct {
	Name string `json:"name"`
}

// cloneList handles POST /api/lists/{listId}/clone (§7.5 [D-72]): a new list
// with the cloner as its sole member and copies of the source's living
// categories and items, shopping state verbatim [D-72]. Category ids are
// fresh and every item's category_key is remapped (populateList).
func (h handlers) cloneList(e *core.RequestEvent) error {
	var body cloneListBody
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}

	sourceID := e.Request.PathValue("listId")

	// Tombstoned source rows are never copied.
	sourceCats, err := e.App.FindRecordsByFilter("list_categories", "list = {:list} && deleted_at = ''", "+sort_order", 0, 0, dbx.Params{"list": sourceID})
	if err != nil {
		return e.InternalServerError("failed to load categories", err)
	}
	sourceItems, err := e.App.FindRecordsByFilter("items", "list = {:list} && deleted_at = ''", "+created", 0, 0, dbx.Params{"list": sourceID})
	if err != nil {
		return e.InternalServerError("failed to load items", err)
	}
	// [D-217] A source can only hold more living rows than the cap after the
	// operator lowered it; its copy would start over the cap.
	if len(sourceItems) > h.caps.Items {
		return e.BadRequestError("too many items", nil)
	}

	cats := make([]seedCategory, 0, len(sourceCats))
	for _, rec := range sourceCats {
		cat := seedCategory{
			Key:       rec.Id,
			Icon:      rec.GetString("icon"),
			Color:     rec.GetString("color"),
			SortOrder: rec.GetInt("sort_order"),
		}
		cat.Slug = optionalText(rec, "slug")
		cat.Name = optionalText(rec, "name")
		cats = append(cats, cat)
	}

	items := make([]seedItem, 0, len(sourceItems))
	for _, rec := range sourceItems {
		item := seedItem{
			Name:        rec.GetString("name"),
			NameDE:      optionalText(rec, "name_de"),
			NameEN:      optionalText(rec, "name_en"),
			Quantity:    rec.GetString("quantity"),
			Note:        optionalText(rec, "note"),
			CategoryKey: optionalText(rec, "category_key"),
			Barcode:     optionalText(rec, "barcode"),
			Checked:     rec.GetBool("checked"),
		}
		// checked_at only pairs with checked=true; the purchase dates are independent.
		if item.Checked {
			item.CheckedAt = optionalTime(rec, "checked_at")
		}
		item.LastBoughtAt = optionalTime(rec, "last_bought_at")
		item.PrevBoughtAt = optionalTime(rec, "prev_bought_at")
		items = append(items, item)
	}

	listRec, err := populateList(e.App, h.caps.Lists, randid.ID(), e.Auth.Id, body.Name, cats, items)
	if err != nil {
		return populateFailed(e, err, h.caps.Lists, "failed to clone list")
	}

	return e.JSON(http.StatusOK, listRec)
}

// optionalText is a text column as a seed field: nil when empty, which is how
// PocketBase stores an unset nullable one.
func optionalText(rec *core.Record, field string) *string {
	if v := rec.GetString(field); v != "" {
		return &v
	}
	return nil
}

// optionalTime is a date column as a seed field: nil when unset.
func optionalTime(rec *core.Record, field string) *types.DateTime {
	if dt := rec.GetDateTime(field); !dt.IsZero() {
		return &dt
	}
	return nil
}
