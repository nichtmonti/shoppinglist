package barcode

import (
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	pbsecurity "github.com/pocketbase/pocketbase/tools/security"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/records"
)

// positiveCacheTTL is how long a found product is served from the cache;
// negativeCacheTTL is the short one for a miss, so a transient upstream
// failure does not poison a real product for long.
const (
	positiveCacheTTL = 30 * 24 * time.Hour
	negativeCacheTTL = 5 * time.Minute
)

// photoMissed is a hit whose upstream named a photo the server holds none of:
// its download is under way or failed for a reason that can pass, since one
// that cannot clears the URL (settlePhoto). It is looked up again after
// negativeCacheTTL, not positiveCacheTTL, and the retry job tries it too.
func photoMissed(rec *core.Record) bool {
	return rec.GetString("image_url") != "" && rec.GetString("photo") == ""
}

// maxUpstreamImageURLBytes bounds the upstream photo URL a cache row keeps: it
// is only ever fetched, never shown, and longer than any real one.
const maxUpstreamImageURLBytes = 2048

// findCache returns the barcode's cache row, or nil when there is none. A
// failed read is an error, never a miss ([D-191]).
func findCache(app core.App, ean string) (*core.Record, error) {
	return records.FindFirstOptional(app, "barcode_cache", dbx.HashExp{"barcode": ean})
}

// saveCache writes one lookup's result onto the barcode's cache row, adding
// the row when there is none.
func saveCache(app core.App, ean string, found *fetchedProduct) (*core.Record, error) {
	rec, err := findCache(app, ean)
	if err != nil {
		return nil, err
	}
	if rec != nil {
		return rec, fillAndSaveCache(app, rec, found)
	}
	c, err := app.FindCachedCollectionByNameOrId("barcode_cache")
	if err != nil {
		return nil, err
	}
	rec = core.NewRecord(c)
	rec.Set("barcode", ean)
	saveErr := fillAndSaveCache(app, rec, found)
	if saveErr == nil {
		return rec, nil
	}
	// Two lookups missing the cache for one barcode both insert, and the second
	// meets the first one's row on the unique barcode index. The lookup itself
	// worked, so it updates that row instead of failing.
	existing, err := findCache(app, ean)
	if err != nil || existing == nil {
		return nil, saveErr
	}
	return existing, fillAndSaveCache(app, existing, found)
}

// fillAndSaveCache writes one lookup's result onto its cache row.
func fillAndSaveCache(app core.App, rec *core.Record, found *fetchedProduct) error {
	rec.Set("found", found != nil)
	rec.Set("fetched_at", types.NowDateTime())
	if found == nil {
		// The photo is deliberately left in place: existing items sync its
		// token URL, and clearing it would blank their picture when a product
		// is delisted upstream. A new scan of a `found: false` row gets a 404,
		// and SweepPhotos still bounds the storage.
		rec.Set("name", "")
		rec.Set("name_de", "")
		rec.Set("name_en", "")
		rec.Set("image_url", "")
		rec.Set("category_slug", "")
		return app.SaveNoValidate(rec)
	}

	// Upstream strings are bounded here, since SaveNoValidate skips
	// PocketBase's validation: each name is cut to the items column it is
	// copied into, and an over-long URL is dropped, as a cut one would point
	// nowhere.
	rec.Set("name", fieldcontract.Truncate("items", "name", found.Name))
	rec.Set("name_de", fieldcontract.Truncate("items", "name_de", found.NameDE))
	rec.Set("name_en", fieldcontract.Truncate("items", "name_en", found.NameEN))
	imageURL := found.UpstreamImageURL
	if len(imageURL) > maxUpstreamImageURLBytes {
		imageURL = ""
	}
	rec.Set("image_url", imageURL)
	rec.Set("category_slug", found.CategorySlug)

	if len(found.PhotoBytes) > 0 {
		if err := setPhoto(app, rec, found.PhotoBytes, found.PhotoExt); err != nil {
			return err
		}
	}
	return app.SaveNoValidate(rec)
}

// setPhoto puts photo bytes on a cache row, unsaved. The token is reused while
// the bytes are unchanged, since existing items sync its URL, and rotated when
// they differ, since the served URL is `immutable`. Not while an item shows
// the old one: the rotation deletes the file behind it ([D-21]), so the new
// photo waits until no item does.
func setPhoto(app core.App, rec *core.Record, data []byte, ext string) error {
	hash := pbsecurity.SHA256(string(data))
	rotate := rec.GetString("photo") == "" || rec.GetString("photo_token") == ""
	if !rotate && rec.GetString("photo_hash") != hash {
		shown, err := photoShown(app, rec.GetString("photo_token"))
		if err != nil {
			return err
		}
		rotate = !shown
	}
	if !rotate {
		return nil
	}
	// Not the record id: the token rotates with the bytes. See migration
	// 1778000005 for why the route is open.
	token := randid.ID()
	// Named after the token, not the barcode: PocketBase echoes the filename
	// in Content-Disposition, which would leak the product.
	file, err := filesystem.NewFileFromBytes(data, token+"."+ext)
	if err != nil {
		return err
	}
	rec.Set("photo", file)
	rec.Set("photo_token", token)
	rec.Set("photo_hash", hash)
	return nil
}
