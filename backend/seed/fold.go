package seed

import (
	"errors"
	"slices"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/normalize"
	"shoppinglist/internal/tombstone"
)

// foldVersion is the seed that brought lists made before [D-300] its aisles
// ([D-302]): Run folds them once, on the boot that crosses it.
const foldVersion = 8

// foldOldAisles gives every list what [D-300] gave only new ones ([D-302]):
//
//   - Garten folds into Baumarkt: its items move to the list's Baumarkt row
//     and the Garten row is hidden. Not when someone renamed Garten, or the
//     list has no Baumarkt row it shows: then the members chose it.
//   - Every list without a `coffee_tea` row gets one after Frühstück, the
//     rows behind it moving down one. On every list that shows the aisle,
//     added here or by the button ([D-251]), its coffees and teas move over
//     from Getränke and Sonstiges: an item whose normalized name is one the
//     dictionary files under `coffee_tea`. An item a member filed in another
//     aisle stays there, and a list whose members hid the aisle keeps none.
//
// Once, not on every seed, so a coffee moved back to Getränke stays there.
// Every row is saved as a record, which stamps `updated`, so each device
// pulls it on its next sync.
func foldOldAisles(app core.App) error {
	teaIcon, teaColor, err := template("coffee_tea")
	if err != nil {
		return err
	}
	teaNames := dictionaryNames("coffee_tea")
	return app.RunInTransaction(func(tx core.App) error {
		categories, err := tx.FindCollectionByNameOrId("list_categories")
		if err != nil {
			return err
		}
		var lists []string
		if err := tx.DB().NewQuery("SELECT id FROM lists").Column(&lists); err != nil {
			return err
		}
		now := types.NowDateTime()
		for _, list := range lists {
			rows, err := tx.FindRecordsByFilter("list_categories",
				"list = {:list}", "+sort_order", 0, 0, dbx.Params{"list": list})
			if err != nil {
				return err
			}
			items, err := tx.FindRecordsByFilter("items",
				"list = {:list}", "", 0, 0, dbx.Params{"list": list})
			if err != nil {
				return err
			}
			if err := foldGarden(tx, rows, items, now); err != nil {
				return err
			}
			tea := shown(rows, "coffee_tea")
			if tea == nil {
				if hidden(rows, "coffee_tea") {
					continue
				}
				if tea, err = addTeaRow(tx, categories, list, rows, teaIcon, teaColor); err != nil {
					return err
				}
			}
			// An item is in Getränke or Sonstiges when its key names either row
			// or no row the list shows (§6.6: it renders under Sonstiges).
			filed := map[string]bool{}
			for _, r := range rows {
				if s := r.GetString("slug"); s != "beverages" && s != "other" && tombstone.Living(r) {
					filed[r.Id] = true
				}
			}
			for _, item := range items {
				if teaNames[item.GetString("name_norm")] && !filed[item.GetString("category_key")] {
					item.Set("category_key", tea.Id)
					if err := tx.SaveNoValidate(item); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
}

// foldGarden moves the items of the list's Garten row to its Baumarkt row and
// hides the Garten row, unless Garten was renamed or Baumarkt is not shown.
func foldGarden(app core.App, rows, items []*core.Record, now types.DateTime) error {
	garden, hardware := shown(rows, "garden"), shown(rows, "hardware")
	if garden == nil || garden.GetString("name") != "" || hardware == nil {
		return nil
	}
	for _, item := range items {
		if item.GetString("category_key") == garden.Id {
			item.Set("category_key", hardware.Id)
			if err := app.SaveNoValidate(item); err != nil {
				return err
			}
		}
	}
	garden.Set("deleted_at", now)
	return app.SaveNoValidate(garden)
}

// addTeaRow adds the list's coffee_tea row after Frühstück, or after every
// row when the list does not show Frühstück, moving the rows behind it down
// one.
func addTeaRow(app core.App, categories *core.Collection, list string, rows []*core.Record,
	icon, color string) (*core.Record, error) {
	at := 0
	if breakfast := shown(rows, "breakfast"); breakfast != nil {
		at = breakfast.GetInt("sort_order") + 1
	} else {
		for _, r := range rows {
			at = max(at, r.GetInt("sort_order")+1)
		}
	}
	for _, r := range rows {
		if o := r.GetInt("sort_order"); o >= at {
			r.Set("sort_order", o+1)
			if err := app.SaveNoValidate(r); err != nil {
				return nil, err
			}
		}
	}
	tea := core.NewRecord(categories)
	tea.Set("list", list)
	tea.Set("slug", "coffee_tea")
	tea.Set("icon", icon)
	tea.Set("color", color)
	tea.Set("sort_order", at)
	return tea, app.SaveNoValidate(tea)
}

// shown is the list's row for slug that is not hidden, or nil.
func shown(rows []*core.Record, slug string) *core.Record {
	for _, r := range rows {
		if r.GetString("slug") == slug && tombstone.Living(r) {
			return r
		}
	}
	return nil
}

// hidden reports whether the list has a row for slug its members hid.
func hidden(rows []*core.Record, slug string) bool {
	for _, r := range rows {
		if r.GetString("slug") == slug && tombstone.Deleted(r) {
			return true
		}
	}
	return false
}

// template is the embedded seed's icon and colour for slug.
func template(slug string) (icon, color string, err error) {
	i := slices.IndexFunc(templates, func(r categorySeed) bool { return r.Slug == slug })
	if i < 0 {
		return "", "", errors.New("seed: no category template " + slug)
	}
	return templates[i].Icon, templates[i].Color, nil
}

// dictionaryNames is every name and synonym, in every language and normalized
// ([D-44]), of the dictionary entries whose default category is slug.
func dictionaryNames(slug string) map[string]bool {
	names := map[string]bool{}
	for _, r := range dictionary {
		if r.DefaultCategory != slug {
			continue
		}
		for _, list := range r.NamesI18n {
			for _, n := range list {
				names[normalize.Name(n)] = true
			}
		}
	}
	return names
}
