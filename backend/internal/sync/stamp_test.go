package sync

import (
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/normalize"
	"shoppinglist/internal/testutil"
)

// Two writes to one row inside a millisecond must leave different stamps: the
// digest hashes id:updated, and an unchanged stamp hides the second write from
// every device that saw the first (§8.5, [D-40]).
func TestEveryWriteMovesUpdated(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app)
	listID := testutil.CreateList(t, app, "Test")
	item := testutil.CreateItem(t, app, listID, "Tee")

	seen := map[string]bool{item.GetString("updated"): true}
	for i := range 20 { // back to back, many inside one millisecond
		item.Set("quantity", string(rune('a'+i)))
		if err := app.Save(item); err != nil {
			t.Fatal(err)
		}
		stamp := item.GetString("updated")
		if seen[stamp] {
			t.Fatalf("write %d kept the stamp %s", i, stamp)
		}
		seen[stamp] = true
	}
	fresh, err := app.FindRecordById("items", item.Id)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.GetString("updated") != item.GetString("updated") {
		t.Fatalf("stored %s, saved %s", fresh.GetString("updated"), item.GetString("updated"))
	}
}

// Every save of an item, the dashboard's too, stores the [D-29] merge key
// from the name, whatever the row carried.
func TestEverySaveStampsTheMergeKey(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app)
	listID := testutil.CreateList(t, app, "Test")
	item := testutil.CreateItem(t, app, listID, "  Hafer Milch ", func(r *core.Record) { r.Set("name_norm", "stale") })
	if got, want := item.GetString("name_norm"), normalize.Name("  Hafer Milch "); got != want {
		t.Errorf("create: name_norm %q, want %q", got, want)
	}
	item.Set("name", "Milch")
	item.Set("name_norm", "stale")
	if err := app.Save(item); err != nil {
		t.Fatal(err)
	}
	if got := item.GetString("name_norm"); got != "milch" {
		t.Errorf("rename: name_norm %q, want %q", got, "milch")
	}
}

func TestNextStamp(t *testing.T) {
	last, _ := types.ParseDateTime("2026-10-13 22:55:48.944Z")
	for _, c := range []struct {
		name string
		now  time.Time
		want string
	}{
		{"the clock moved on", last.Time().Add(3 * time.Millisecond), "2026-10-13 22:55:48.947Z"},
		{"the same millisecond", last.Time().Add(400 * time.Microsecond), "2026-10-13 22:55:48.945Z"},
		{"a clock behind the row", last.Time().Add(-time.Second), "2026-10-13 22:55:48.945Z"},
	} {
		if got := nextStamp(last, c.now).String(); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	if got := nextStamp(types.DateTime{}, last.Time()).String(); got != last.String() {
		t.Errorf("no stamp yet: %s, want %s", got, last.String())
	}
}

// NextStampSQL, the stamp a raw UPDATE writes, is nextStamp's: the clear
// would otherwise move a busy row's stamp differently from a saved one.
func TestNextStampSQLIsNextStamp(t *testing.T) {
	app := testutil.NewApp(t)
	listID := testutil.CreateList(t, app, "Test")
	id := testutil.CreateItem(t, app, listID, "Tee").Id
	last, _ := types.ParseDateTime("2026-10-13 22:55:48.944Z")
	for _, now := range []time.Time{
		last.Time().Add(3 * time.Millisecond),
		last.Time().Add(400 * time.Microsecond),
		last.Time().Add(-time.Second),
	} {
		if _, err := app.DB().NewQuery(`UPDATE items SET updated = {:last} WHERE id = {:id}`).
			Bind(dbx.Params{"id": id, "last": last.String()}).Execute(); err != nil {
			t.Fatal(err)
		}
		at, _ := types.ParseDateTime(now.Truncate(time.Millisecond))
		var got string
		err := app.DB().NewQuery(`UPDATE items SET updated = ` + NextStampSQL + ` WHERE id = {:id} RETURNING updated`).
			Bind(dbx.Params{"id": id, "now": at.String()}).Row(&got)
		if err != nil {
			t.Fatal(err)
		}
		if want := nextStamp(last, now).String(); got != want {
			t.Errorf("now %s: SQL %s, nextStamp %s", at, got, want)
		}
	}
}
