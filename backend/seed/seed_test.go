package seed

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil/testapp"
)

// TestItemIDParity proves the deterministic id derived from each item's canonical
// en name equals the pre-authored id in seed/items.json (docs/internals/design.md §6.12, [D-44]).
func TestItemIDParity(t *testing.T) {
	for _, r := range dictionary {
		en := ""
		if v := r.NamesI18n["en"]; len(v) > 0 {
			en = v[0]
		}
		if got, want := ItemID(en), r.ID; got != want {
			t.Errorf("ItemID(%q) = %q, want %q", en, got, want)
		}
	}
}

// TestRunSeedsAndIsIdempotent verifies a fresh boot seeds exactly the number of
// templates and dictionary rows present in the embedded JSON, and that a second
// Run leaves counts unchanged.
func TestRunSeedsAndIsIdempotent(t *testing.T) {
	app := testapp.New(t)
	if err := Run(app); err != nil {
		t.Fatalf("Run: %v", err)
	}
	wantCategories := len(templates)
	if n, err := app.CountRecords("category_templates"); err != nil || n != int64(wantCategories) {
		t.Errorf("category_templates count = %d (err %v), want %d", n, err, wantCategories)
	}
	wantItems := len(dictionary)
	if n, err := app.CountRecords("item_dictionary"); err != nil || n != int64(wantItems) {
		t.Errorf("item_dictionary count = %d (err %v), want %d", n, err, wantItems)
	}

	// second Run is gated by the stored seed_version -> counts unchanged
	if err := Run(app); err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if n, _ := app.CountRecords("category_templates"); n != int64(wantCategories) {
		t.Errorf("category_templates count after re-run = %d, want %d", n, wantCategories)
	}
	if n, _ := app.CountRecords("item_dictionary"); n != int64(wantItems) {
		t.Errorf("item_dictionary count after re-run = %d, want %d", n, wantItems)
	}

	// spot-check a category and a dictionary row landed with content
	tpl, _ := app.FindFirstRecordByData("category_templates", "slug", "other")
	if tpl == nil {
		t.Fatal("seeded 'other' category_template not found")
	}
	if tpl.GetString("color") != "gray" {
		t.Errorf("'other' color = %q, want gray", tpl.GetString("color"))
	}
	dict, _ := app.FindFirstRecordByData("item_dictionary", "id", "item_cucumber")
	if dict == nil {
		t.Fatal("seeded 'item_cucumber' not found")
	}
	if dict.GetString("default_category") != "produce" {
		t.Errorf("cucumber default_category = %q, want produce", dict.GetString("default_category"))
	}
}

// TestRunMovesListsOffAnOldDefaultIcon: a template whose icon changed takes
// every list's category still on the old icon with it, and leaves one whose
// icon someone changed ([D-287]). The move stamps `updated`, which is what
// the digest tells devices by.
func TestRunMovesListsOffAnOldDefaultIcon(t *testing.T) {
	app := testapp.New(t)
	if err := Run(app); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The state before this seed: the template on the old icon, and two
	// lists' rows for it, one untouched, one changed by hand.
	tpl, _ := app.FindFirstRecordByData("category_templates", "slug", "baking_spices")
	if tpl == nil {
		t.Fatal("baking_spices template not found")
	}
	newIcon := tpl.GetString("icon")
	tpl.Set("icon", "🧂")
	if err := app.SaveNoValidate(tpl); err != nil {
		t.Fatal(err)
	}
	col, err := app.FindCollectionByNameOrId("list_categories")
	if err != nil {
		t.Fatal(err)
	}
	row := func(list, icon string) *core.Record {
		r := core.NewRecord(col)
		r.Set("list", list)
		r.Set("slug", "baking_spices")
		r.Set("icon", icon)
		r.Set("color", "brown")
		if err := app.SaveNoValidate(r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	untouched := row("list_untouched1", "🧂")
	changed := row("list_changed123", "🌿")
	before := untouched.GetDateTime("updated")
	if err := writeSeedVersion(app, "5"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)

	if err := Run(app); err != nil {
		t.Fatalf("Run: %v", err)
	}

	got, _ := app.FindRecordById("list_categories", untouched.Id)
	if got.GetString("icon") != newIcon {
		t.Errorf("untouched row icon = %q, want the new default %q", got.GetString("icon"), newIcon)
	}
	if !got.GetDateTime("updated").After(before) {
		t.Error("the moved row's updated was not stamped, so no device would pull it")
	}
	kept, _ := app.FindRecordById("list_categories", changed.Id)
	if kept.GetString("icon") != "🌿" {
		t.Errorf("hand-changed row icon = %q, want 🌿 kept", kept.GetString("icon"))
	}
}
