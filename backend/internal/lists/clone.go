package lists

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
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
		cats = append(cats, seedCategory{
			Key:       rec.Id,
			Slug:      rec.GetString("slug"),
			Name:      rec.GetString("name"),
			Icon:      rec.GetString("icon"),
			Color:     rec.GetString("color"),
			SortOrder: rec.GetInt("sort_order"),
		})
	}

	items := make([]seedItem, 0, len(sourceItems))
	for _, rec := range sourceItems {
		item := seedItem{
			Name:         rec.GetString("name"),
			NameDE:       rec.GetString("name_de"),
			NameEN:       rec.GetString("name_en"),
			Quantity:     rec.GetString("quantity"),
			Note:         rec.GetString("note"),
			CategoryKey:  rec.GetString("category_key"),
			Barcode:      rec.GetString("barcode"),
			Checked:      rec.GetBool("checked"),
			LastBoughtAt: rec.GetDateTime("last_bought_at"),
			PrevBoughtAt: rec.GetDateTime("prev_bought_at"),
		}
		// checked_at only pairs with checked=true; the purchase dates are independent.
		if item.Checked {
			item.CheckedAt = rec.GetDateTime("checked_at")
		}
		items = append(items, item)
	}

	listRec, err := populateList(e.App, h.caps.Lists, e.Auth.Id, body.Name, cats, items)
	if err != nil {
		return populateFailed(e, err, h.caps.Lists, "failed to clone list")
	}

	return e.JSON(http.StatusOK, listRec)
}
