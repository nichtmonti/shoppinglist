package lists

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
)

// createListBody carries only the list's name ([D-08]). The id is
// SERVER-minted ([D-08]) — an `id` in the body is ignored.
type createListBody struct {
	Name string `json:"name"`
}

// createList handles POST /api/lists (§7.5): the list, the creator as its sole
// member and a per-list copy of the current category_templates ([D-300]), through
// populateList.
func (h handlers) createList(e *core.RequestEvent) error {
	var body createListBody
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}
	cats, err := activeTemplates(e.App)
	if err != nil {
		return e.InternalServerError("failed to load category templates", err)
	}
	listRec, err := populateList(e.App, h.caps.Lists, e.Auth.Id, body.Name, cats, nil)
	if err != nil {
		return populateFailed(e, err, h.caps.Lists, "failed to create list")
	}
	return e.JSON(http.StatusOK, listRec)
}

// activeTemplates is every category template not retired ([D-300]), in the
// templates' order, as the list row it seeds: its slug (also the join key),
// icon, colour and sort order, and a null name, which the client renders as
// the localized default (§6.7).
func activeTemplates(app core.App) ([]seedCategory, error) {
	templates, err := app.FindRecordsByFilter("category_templates", "retired = false", "+sort_order", 0, 0)
	if err != nil {
		return nil, err
	}
	cats := make([]seedCategory, 0, len(templates))
	for _, tpl := range templates {
		slug := tpl.GetString("slug")
		cats = append(cats, seedCategory{
			Key:       slug,
			Slug:      slug,
			Icon:      tpl.GetString("icon"),
			Color:     tpl.GetString("color"),
			SortOrder: tpl.GetInt("sort_order"),
		})
	}
	return cats, nil
}
