// Migration 1778000019 — a seeded aisle can be retired ([D-300]).
//
// A retired template is no longer copied into a new list, offered to an older
// one or used by a text import, but stays readable, so a list that has its
// row keeps the localized name and a backup that carries its slug still
// imports ([D-08]).

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(retiredCategoryTemplatesUp, retiredCategoryTemplatesDown, "1778000019_retired_category_templates.go")
}

func retiredCategoryTemplatesUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("category_templates")
	if err != nil {
		return err
	}
	col.Fields.Add(&core.BoolField{Name: "retired"})
	return app.Save(col)
}

func retiredCategoryTemplatesDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("category_templates")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("retired")
	return app.Save(col)
}
