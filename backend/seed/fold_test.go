package seed

import (
	"fmt"
	"testing"

	"github.com/pocketbase/pocketbase"

	"shoppinglist/internal/normalize"
	"shoppinglist/internal/testutil/testapp"
)

const foldStamp = "2026-01-01 00:00:00.000Z"

// sqlExec writes a row the way deployed data has it, past the record pipeline.
func sqlExec(t *testing.T, app *pocketbase.PocketBase, format string, args ...any) {
	t.Helper()
	if _, err := app.DB().NewQuery(fmt.Sprintf(format, args...)).Execute(); err != nil {
		t.Fatalf("exec %q: %v", fmt.Sprintf(format, args...), err)
	}
}

func foldCategory(t *testing.T, app *pocketbase.PocketBase, id, list, slug, name string, order int, hidden bool) {
	t.Helper()
	deleted := ""
	if hidden {
		deleted = foldStamp
	}
	sqlExec(t, app, `INSERT INTO list_categories (id, list, slug, name, icon, color, sort_order, deleted_at, created, updated)
		VALUES ('%s', '%s', '%s', '%s', '', '', %d, '%s', '%s', '%s')`,
		id, list, slug, name, order, deleted, foldStamp, foldStamp)
}

func foldItem(t *testing.T, app *pocketbase.PocketBase, id, list, name, key string) {
	t.Helper()
	sqlExec(t, app, `INSERT INTO items (id, list, name, name_norm, category_key, created, updated)
		VALUES ('%s', '%s', '%s', '%s', '%s', '%s', '%s')`,
		id, list, name, normalize.Name(name), key, foldStamp, foldStamp)
}

type foldRow struct {
	Id        string `db:"id"`
	Slug      string `db:"slug"`
	SortOrder int    `db:"sort_order"`
	DeletedAt string `db:"deleted_at"`
	Icon      string `db:"icon"`
	Updated   string `db:"updated"`
}

func foldRows(t *testing.T, app *pocketbase.PocketBase, list string) map[string][]foldRow {
	t.Helper()
	var rows []foldRow
	if err := app.DB().NewQuery("SELECT id, slug, sort_order, deleted_at, icon, updated FROM list_categories WHERE list = {:list}").
		Bind(map[string]any{"list": list}).All(&rows); err != nil {
		t.Fatalf("read rows of %s: %v", list, err)
	}
	bySlug := map[string][]foldRow{}
	for _, r := range rows {
		bySlug[r.Slug] = append(bySlug[r.Slug], r)
	}
	return bySlug
}

func foldKey(t *testing.T, app *pocketbase.PocketBase, item string) string {
	t.Helper()
	var key string
	if err := app.DB().NewQuery("SELECT category_key FROM items WHERE id = {:id}").
		Bind(map[string]any{"id": item}).Row(&key); err != nil {
		t.Fatalf("read category_key of %s: %v", item, err)
	}
	return key
}

// TestRunFoldsOldAisles ([D-302]): the boot that crosses foldVersion folds a
// list's Garten into Baumarkt and gives it the tea aisle after Frühstück with
// its coffees and teas; what the members chose (a renamed Garten, a coffee
// filed elsewhere, a hidden tea aisle) stays.
func TestRunFoldsOldAisles(t *testing.T) {
	app := testapp.New(t)
	for _, l := range []string{"listold", "listown", "listbutton", "listhid"} {
		sqlExec(t, app, `INSERT INTO lists (id, created, updated) VALUES ('%s', '%s', '%s')`, l, foldStamp, foldStamp)
	}

	// An untouched pre-[D-300] list.
	foldCategory(t, app, "oproduce", "listold", "produce", "", 0, false)
	foldCategory(t, app, "obreakfast", "listold", "breakfast", "", 1, false)
	foldCategory(t, app, "obeverages", "listold", "beverages", "", 2, false)
	foldCategory(t, app, "ohardware", "listold", "hardware", "", 3, false)
	foldCategory(t, app, "ogarden", "listold", "garden", "", 4, false)
	foldCategory(t, app, "oother", "listold", "other", "", 5, false)
	foldItem(t, app, "isoil", "listold", "Blumenerde", "ogarden")
	foldItem(t, app, "icoffee", "listold", "Kaffee", "obeverages")
	foldItem(t, app, "ichamomile", "listold", "Kamillentee", "oother")
	foldItem(t, app, "icocoa", "listold", "kakao", "")
	foldItem(t, app, "iteabreakfast", "listold", "Tee", "obreakfast")
	foldItem(t, app, "iwater", "listold", "Wasser", "obeverages")

	// Its members renamed Garten and hid Frühstück.
	foldCategory(t, app, "wbreakfast", "listown", "breakfast", "", 0, true)
	foldCategory(t, app, "whardware", "listown", "hardware", "", 1, false)
	foldCategory(t, app, "wgarden", "listown", "garden", "Balkon", 2, false)
	foldCategory(t, app, "wother", "listown", "other", "", 3, false)
	foldItem(t, app, "wsoil", "listown", "Blumenerde", "wgarden")

	// The tea aisle came by the button ([D-251]), the coffee stayed behind.
	foldCategory(t, app, "bbeverages", "listbutton", "beverages", "", 0, false)
	foldCategory(t, app, "bother", "listbutton", "other", "", 1, false)
	foldCategory(t, app, "btea", "listbutton", "coffee_tea", "", 2, false)
	foldItem(t, app, "bcoffee", "listbutton", "Kaffee", "bbeverages")

	// Its members hid the tea aisle.
	foldCategory(t, app, "hbeverages", "listhid", "beverages", "", 0, false)
	foldCategory(t, app, "htea", "listhid", "coffee_tea", "", 1, true)
	foldItem(t, app, "hcoffee", "listhid", "Kaffee", "hbeverages")

	if err := writeSeedVersion(app, "7"); err != nil {
		t.Fatal(err)
	}
	if err := Run(app); err != nil {
		t.Fatalf("Run: %v", err)
	}

	old := foldRows(t, app, "listold")
	if len(old["coffee_tea"]) != 1 {
		t.Fatalf("listold: %d coffee_tea rows, want 1", len(old["coffee_tea"]))
	}
	tea := old["coffee_tea"][0]
	if tea.Icon != "🍵" || tea.DeletedAt != "" {
		t.Errorf("listold: tea row icon %q deleted_at %q, want 🍵 and shown", tea.Icon, tea.DeletedAt)
	}
	for slug, want := range map[string]int{"produce": 0, "breakfast": 1, "coffee_tea": 2, "beverages": 3, "hardware": 4, "garden": 5, "other": 6} {
		if got := old[slug][0].SortOrder; got != want {
			t.Errorf("listold: %s at %d, want %d", slug, got, want)
		}
	}
	if old["garden"][0].DeletedAt == "" {
		t.Error("listold: Garten still shown, want it hidden")
	}
	if old["produce"][0].Updated != foldStamp {
		t.Error("listold: Obst & Gemüse was saved though nothing about it changed")
	}
	if old["beverages"][0].Updated == foldStamp {
		t.Error("listold: Getränke moved without a new `updated`, so no device would pull it")
	}
	for item, want := range map[string]string{
		"isoil": "ohardware", "icoffee": tea.Id, "ichamomile": tea.Id, "icocoa": tea.Id,
		"iteabreakfast": "obreakfast", "iwater": "obeverages",
	} {
		if got := foldKey(t, app, item); got != want {
			t.Errorf("listold: %s in %q, want %q", item, got, want)
		}
	}

	own := foldRows(t, app, "listown")
	if own["garden"][0].DeletedAt != "" || foldKey(t, app, "wsoil") != "wgarden" {
		t.Error("listown: the renamed Garten was folded, want it kept with its items")
	}
	if got := own["coffee_tea"]; len(got) != 1 || got[0].SortOrder != 4 {
		t.Errorf("listown: tea rows %+v, want one after every row (4), Frühstück being hidden", got)
	}

	button := foldRows(t, app, "listbutton")
	if len(button["coffee_tea"]) != 1 || foldKey(t, app, "bcoffee") != "btea" {
		t.Errorf("listbutton: %d tea rows, coffee in %q; want the one row and the coffee in it",
			len(button["coffee_tea"]), foldKey(t, app, "bcoffee"))
	}

	if hid := foldRows(t, app, "listhid"); len(hid["coffee_tea"]) != 1 || foldKey(t, app, "hcoffee") != "hbeverages" {
		t.Error("listhid: the hidden tea aisle came back or took the coffee")
	}
}
