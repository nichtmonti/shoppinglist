package lists

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/security"
)

// addMissingCategories handles POST /api/lists/{listId}/categories/missing
// ([D-251]): it adds to the list a row for every category template not
// retired ([D-300]) the list has no row for, so a list made before the seed grew an aisle ([D-251]) can
// take it. A server route because `slug` is server-owned ([D-08]): only a row
// with the template's slug is the template's aisle for the dictionary and the
// classifier, and no client op may set one.
//
// A template counts as present when the list has a row for its slug at all,
// a removed one included: a member who removed an aisle chose to, and this
// does not bring it back. The new rows take the template's icon and colour
// and a null name (the localized default, §6.7), and go after every row the
// list has, in the templates' order, so nothing the members arranged moves.
// Others stays last however its sort_order compares (§9).
//
// One transaction, so two members pressing the button at once add each
// template once, and the membership is checked again inside it (§7.3). Each row is saved through the record pipeline, which stamps
// `updated` and broadcasts it, so every member's next cycle pulls it.
func addMissingCategories(e *core.RequestEvent) error {
	listID := e.Request.PathValue("listId")
	added := []string{}

	err := e.App.RunInTransaction(func(txApp core.App) error {
		if err := security.CheckListMembership(txApp, e); err != nil {
			return err
		}
		rows, err := txApp.FindRecordsByFilter("list_categories",
			"list = {:list}", "", 0, 0, dbx.Params{"list": listID})
		if err != nil {
			return err
		}
		have := make(map[string]bool, len(rows))
		next := 0
		for _, r := range rows {
			if slug := r.GetString("slug"); slug != "" {
				have[slug] = true
			}
			if o := r.GetInt("sort_order"); o >= next {
				next = o + 1
			}
		}

		templates, err := activeTemplates(txApp)
		if err != nil {
			return err
		}
		col, err := txApp.FindCachedCollectionByNameOrId("list_categories")
		if err != nil {
			return err
		}
		for _, tpl := range templates {
			if have[tpl.Slug] {
				continue
			}
			rec := core.NewRecord(col)
			rec.Set("list", listID)
			rec.Set("slug", tpl.Slug)
			rec.Set("icon", tpl.Icon)
			rec.Set("color", tpl.Color)
			rec.Set("sort_order", next)
			next++
			if err := txApp.SaveNoValidate(rec); err != nil {
				return err
			}
			added = append(added, tpl.Slug)
		}
		return nil
	})
	if err != nil {
		return security.RefusalOr500(e, "failed to add the missing categories", err)
	}

	return e.JSON(http.StatusOK, map[string]any{"added": added})
}
