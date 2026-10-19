package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	pbmigrations.Register(createBarcodeCacheUp, createBarcodeCacheDown, "1778000001_create_barcode_cache.go")
}

func createBarcodeCacheUp(app core.App) error {
	c := core.NewBaseCollection("barcode_cache")
	c.Fields.Add(
		&core.TextField{Name: "barcode", Required: true},
		&core.TextField{Name: "name"},
		&core.TextField{Name: "image_url"},
		&core.TextField{Name: "category_slug"},
		&core.BoolField{Name: "found"},
		&core.DateField{Name: "fetched_at", Required: true},
	)
	c.Indexes = types.JSONArray[string]{`CREATE UNIQUE INDEX ` + "`idx_barcode_cache_barcode`" + ` ON ` + "`barcode_cache`" + ` (` + "`barcode`" + `)`}
	// Server-only cache. The route performs its own authenticated access check.
	return app.Save(c)
}

func createBarcodeCacheDown(app core.App) error {
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		return err
	}
	return app.Delete(c)
}
