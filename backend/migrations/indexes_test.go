package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase"
)

func collectionHasIndex(t *testing.T, app *pocketbase.PocketBase, collection, name string) bool {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(collection)
	if err != nil {
		t.Fatalf("find %s: %v", collection, err)
	}
	return col.GetIndex(name) != ""
}

// Reverting the photo migration drops what it added and nothing else: the
// unique barcode index predates it (1778000001).
func TestBarcodeCachePhotoDownKeepsTheBarcodeIndex(t *testing.T) {
	app := newMigratedApp(t)
	if err := barcodeCachePhotoDown(app); err != nil {
		t.Fatalf("down: %v", err)
	}
	if !collectionHasIndex(t, app, "barcode_cache", "idx_barcode_cache_barcode") {
		t.Error("down dropped the unique barcode index it never created")
	}
	if collectionHasIndex(t, app, "barcode_cache", "idx_barcode_cache_photo_token") {
		t.Error("down kept the photo-token index")
	}
}

// memberships is read by list alone (the §7.3 cascade count, the §7.4 roster,
// the invite preview), which the unique (account, list) index cannot serve.
func TestMembershipsListIndex(t *testing.T) {
	app := newMigratedApp(t)
	if !collectionHasIndex(t, app, "memberships", membershipsListIndex) {
		t.Fatal("no index on memberships.list")
	}
	if err := membershipsListDown(app); err != nil {
		t.Fatalf("down: %v", err)
	}
	if collectionHasIndex(t, app, "memberships", membershipsListIndex) {
		t.Error("down kept the list index")
	}
	if !collectionHasIndex(t, app, "memberships", "idx_memberships_account_list") {
		t.Error("down dropped the unique (account, list) index")
	}
}
