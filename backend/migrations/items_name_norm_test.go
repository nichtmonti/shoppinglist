package migrations

import (
	"testing"

	"shoppinglist/internal/normalize"
)

// TestItemsNameNormBackfill ([D-29]): against items stored before the column
// existed, the up migration fills name_norm with the shared normalize.Name of
// each name, so the duplicate-create merge finds them, and moves `updated` so
// members re-pull the rows. A blank name is left without one.
//
// The pre-column schema is rebuilt by running the down migration on a fully
// migrated app.
func TestItemsNameNormBackfill(t *testing.T) {
	app := newMigratedApp(t)
	if err := nameNormDown(app); err != nil {
		t.Fatalf("down: %v", err)
	}

	const stamp = "2026-01-01 00:00:00.000Z"
	names := map[string]string{
		"plain":     "Milch",
		"spaced":    "  Hafer   Milch ",
		"upper":     "ÄPFEL",
		"fullwidth": "Ｔｏｍａｔｅｎ", // NFKC folds it to ASCII
		"blank":     "   ",
	}
	for id, name := range names {
		sqlExec(t, app, `INSERT INTO items (id, list, name, created, updated) VALUES ('%s', 'list1', '%s', '%s', '%s')`,
			id, name, stamp, stamp)
	}

	if err := nameNormUp(app); err != nil {
		t.Fatalf("up: %v", err)
	}

	for id, name := range names {
		var row struct {
			NameNorm string `db:"name_norm"`
			Updated  string `db:"updated"`
		}
		if err := app.DB().NewQuery("SELECT name_norm, updated FROM items WHERE id = {:id}").
			Bind(map[string]any{"id": id}).One(&row); err != nil {
			t.Fatalf("read item %s: %v", id, err)
		}
		if id == "blank" {
			if row.NameNorm != "" || row.Updated != stamp {
				t.Errorf("blank name: name_norm %q, updated %q, want it left alone", row.NameNorm, row.Updated)
			}
			continue
		}
		if want := normalize.Name(name); row.NameNorm != want || want == "" {
			t.Errorf("%s (%q): name_norm = %q, want %q", id, name, row.NameNorm, want)
		}
		if row.Updated == stamp {
			t.Errorf("%s: updated not moved, so members would never re-pull the backfilled row", id)
		}
	}
}

// TestItemsNameNormRefresh: a row the dashboard wrote before the save hook
// has an empty or stale name_norm; the refresh recomputes it and moves
// `updated` on what it fixed, and leaves a right row alone.
func TestItemsNameNormRefresh(t *testing.T) {
	app := newMigratedApp(t)

	const stamp = "2026-01-01 00:00:00.000Z"
	rows := map[string][2]string{ // id: name, stored name_norm
		"empty": {"Brot", ""},
		"stale": {"Hafer  Milch", "milch"},
		"right": {"Äpfel", normalize.Name("Äpfel")},
	}
	for id, r := range rows {
		sqlExec(t, app, `INSERT INTO items (id, list, name, name_norm, created, updated) VALUES ('%s', 'list1', '%s', '%s', '%s', '%s')`,
			id, r[0], r[1], stamp, stamp)
	}

	if err := nameNormRefreshUp(app); err != nil {
		t.Fatalf("up: %v", err)
	}

	for id, r := range rows {
		var row struct {
			NameNorm string `db:"name_norm"`
			Updated  string `db:"updated"`
		}
		if err := app.DB().NewQuery("SELECT name_norm, updated FROM items WHERE id = {:id}").
			Bind(map[string]any{"id": id}).One(&row); err != nil {
			t.Fatalf("read item %s: %v", id, err)
		}
		if want := normalize.Name(r[0]); row.NameNorm != want {
			t.Errorf("%s: name_norm = %q, want %q", id, row.NameNorm, want)
		}
		if moved := row.Updated != stamp; moved != (id != "right") {
			t.Errorf("%s: updated = %q, want moved only on a fixed row", id, row.Updated)
		}
	}
}
