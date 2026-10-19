package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(barcodeCacheLocalizedNamesUp, barcodeCacheLocalizedNamesDown, "1778000011_barcode_cache_localized_names.go")
}

// [D-21]: the product's German and English names as the upstream database
// has them, beside `name` (the main-language name). The lookup route answers
// in the caller's UI language where one is stored and falls back to `name`, so
// a row cached before this migration — both fields empty — reads exactly as it
// did, and picks up its localized names at its next refetch.
func barcodeCacheLocalizedNamesUp(app core.App) error {
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		return err
	}
	c.Fields.Add(
		&core.TextField{Name: "name_de"},
		&core.TextField{Name: "name_en"},
	)
	return app.Save(c)
}

func barcodeCacheLocalizedNamesDown(app core.App) error {
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		return err
	}
	c.Fields.RemoveByName("name_de")
	c.Fields.RemoveByName("name_en")
	return app.Save(c)
}
