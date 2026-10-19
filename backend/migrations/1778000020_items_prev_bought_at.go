// Migration 1778000020 — an item remembers the purchase date a tick replaced,
// so a tick taken back ("not bought") restores it ([D-26]).
//
// Server-owned like last_bought_at, and never sent to the phones: only the push
// route reads it, when an untick says the item was not bought.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(itemsPrevBoughtAtUp, itemsPrevBoughtAtDown, "1778000020_items_prev_bought_at.go")
}

func itemsPrevBoughtAtUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		return err
	}
	col.Fields.Add(&core.DateField{Name: "prev_bought_at"})
	return app.Save(col)
}

func itemsPrevBoughtAtDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("prev_bought_at")
	return app.Save(col)
}
