// Migration 1778000023 — every items and list_categories row remembers the
// last update deliveries the push route decided on it ([D-42]), so a
// re-delivered op is answered from its first verdict instead of applying again.
//
// Server-owned and hidden: only the push route reads and writes it, with a raw
// UPDATE that moves neither `updated` nor the realtime feed.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(rowDeliveriesUp, rowDeliveriesDown, "1778000023_row_deliveries.go")
}

func rowDeliveriesUp(app core.App) error {
	for _, name := range []string{"items", "list_categories"} {
		col, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			return err
		}
		col.Fields.Add(&core.TextField{Name: "deliveries", Hidden: true})
		if err := app.Save(col); err != nil {
			return err
		}
	}
	return nil
}

func rowDeliveriesDown(app core.App) error {
	for _, name := range []string{"items", "list_categories"} {
		col, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			return err
		}
		col.Fields.RemoveByName("deliveries")
		if err := app.Save(col); err != nil {
			return err
		}
	}
	return nil
}
