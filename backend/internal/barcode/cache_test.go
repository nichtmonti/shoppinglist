package barcode

import (
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// Two lookups missing the cache for one barcode at once both insert; the
// second must update the first one's row rather than fail on the unique index
// (a 500 for a lookup that worked).
func TestSaveCacheSurvivesAConcurrentMiss(t *testing.T) {
	app := testutil.NewApp(t)
	raced := false
	app.OnRecordCreate("barcode_cache").BindFunc(func(e *core.RecordEvent) error {
		if !raced {
			// The other lookup's save lands between this one's read and insert.
			raced = true
			other := core.NewRecord(e.Record.Collection())
			other.Set("barcode", e.Record.GetString("barcode"))
			other.Set("found", false)
			if err := e.App.SaveNoValidate(other); err != nil {
				return err
			}
		}
		return e.Next()
	})

	rec, err := saveCache(app, "4006381333931", &fetchedProduct{Name: "Milch"})
	if err != nil {
		t.Fatalf("saveCache after a concurrent insert: %v", err)
	}
	if rec.GetString("name") != "Milch" || !rec.GetBool("found") {
		t.Errorf("saved row = name %q found %v, want this lookup's result", rec.GetString("name"), rec.GetBool("found"))
	}
	rows, err := app.FindAllRecords("barcode_cache", dbx.HashExp{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].GetString("name") != "Milch" {
		t.Errorf("cache rows = %d (first name %q), want one carrying this lookup's result", len(rows), rows[0].GetString("name"))
	}
}

// The upstream image URL is a third party's string stored with SaveNoValidate:
// it is bounded like the names. A cut URL points nowhere, so an over-long one
// is not kept at all.
func TestSaveCacheBoundsTheUpstreamImageURL(t *testing.T) {
	app := testutil.NewApp(t)
	long := "https://images.openfoodfacts.org/" + strings.Repeat("a", 4096)
	rec, err := saveCache(app, "4006381333931", &fetchedProduct{Name: "Milch", UpstreamImageURL: long})
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.GetString("image_url"); got != "" {
		t.Errorf("stored image_url is %d bytes, want it dropped", len(got))
	}

	ok := "https://images.openfoodfacts.org/x.jpg"
	rec, err = saveCache(app, "4006381333948", &fetchedProduct{Name: "Brot", UpstreamImageURL: ok})
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.GetString("image_url"); got != ok {
		t.Errorf("image_url = %q, want %q kept", got, ok)
	}
}
