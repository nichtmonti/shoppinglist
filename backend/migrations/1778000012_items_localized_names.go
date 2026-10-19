package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(itemsLocalizedNamesUp, itemsLocalizedNamesDown, "1778000012_items_localized_names.go")
}

// [D-21]: a scanned item carries the product's German and English names beside
// `name`, so each member sees it in their own UI language. Plain text columns,
// not one JSON map: the push route's per-field merge, caps and null handling
// all speak strings, and a JSON value would have needed a canonical form in
// every one of them. Empty on every existing row, which renders exactly as
// before — no backfill, so no `updated` bump and no re-pull.
func itemsLocalizedNamesUp(app core.App) error {
	c, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		return err
	}
	c.Fields.Add(
		&core.TextField{Name: "name_de"},
		&core.TextField{Name: "name_en"},
	)
	return app.Save(c)
}

func itemsLocalizedNamesDown(app core.App) error {
	c, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		return err
	}
	c.Fields.RemoveByName("name_de")
	c.Fields.RemoveByName("name_en")
	return app.Save(c)
}
