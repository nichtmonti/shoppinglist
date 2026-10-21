package barcode

import (
	"errors"
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"golang.org/x/sync/singleflight"

	"shoppinglist/internal/applog"
)

// A product photo is downloaded apart from its lookup ([D-21]): the lookup
// waits photoWait for it, then answers without it while the download goes on
// for up to photoTimeout. Variables so tests can shorten them.
var (
	photoWait    = 3 * time.Second
	photoTimeout = 60 * time.Second
)

// maxPhotoDownloads bounds the downloads under way at once, so a slow photo
// host cannot pile them up; one refused for want of a slot is the retry
// job's.
const maxPhotoDownloads = 4

// PhotoRetryWindow is how long after its lookup the retry job keeps trying a
// photo that failed for a reason that can pass; photoRetryBatch bounds one
// run.
const (
	PhotoRetryWindow = 48 * time.Hour
	photoRetryBatch  = 10
)

// downloads joins a second lookup or the retry job to the download under way
// for its barcode instead of starting another; downloadSlots holds one token
// per download under way.
var (
	downloads     singleflight.Group
	downloadSlots = make(chan struct{}, maxPhotoDownloads)
)

// downloadPhoto starts downloading the photo at rawURL for barcode ean, unless
// one is under way, and returns a channel that receives once it is settled. A
// download with no free slot is not started, and settles at once. A server
// shutdown drops one under way, and the retry job picks the photo up again.
func downloadPhoto(app core.App, ean, rawURL string) <-chan singleflight.Result {
	return downloads.DoChan(ean, func() (any, error) {
		select {
		case downloadSlots <- struct{}{}:
		default:
			return nil, nil
		}
		defer func() { <-downloadSlots }()
		if err := settlePhoto(app, ean, rawURL, fetchPhoto(rawURL)); err != nil {
			applog.Error(app, "storing a product photo failed", err, "barcode", ean)
		}
		return nil, nil
	})
}

// settlePhoto records a download on the barcode's cache row, unless the row
// has meanwhile moved on to another photo URL. A photo is stored and handed
// to the items that lack one; a failure that cannot pass clears the URL, so
// nothing tries it again until the product is next looked up; one that can
// pass leaves the row as it is, for the next lookup and the retry job.
func settlePhoto(app core.App, ean, rawURL string, got photoDownload) error {
	rec, err := findCache(app, ean)
	if err != nil || rec == nil || rec.GetString("image_url") != rawURL {
		return err
	}
	if got.data == nil {
		if got.retry {
			return nil
		}
		// A site serving its photos from a new host loses every photo until
		// photoHosts names it.
		if got.refused != "" {
			applog.Warn(app, "a product photo's host is not on the allowlist, so it is not stored", nil,
				"host", got.refused, "barcode", ean)
		}
		rec.Set("image_url", "")
		return app.SaveNoValidate(rec)
	}
	if err := setPhoto(app, rec, got.data, got.ext); err != nil {
		return err
	}
	if err := app.SaveNoValidate(rec); err != nil {
		return err
	}
	return fillItems(app, ean, issuedPhotoPath(rec))
}

// fillItems gives every item with barcode ean and no photo the photo just
// stored for it: one scanned while the download was still going, or before
// it failed and was retried. An item that has a photo keeps it ([D-21]). Each
// is saved through the record pipeline, which stamps `updated` for the digest
// and tells every member's device; the items hook leaves image_url alone on a
// save that keeps the barcode ([D-266]).
func fillItems(app core.App, ean, path string) error {
	if path == "" {
		return nil
	}
	items, err := app.FindAllRecords("items", dbx.HashExp{"barcode": ean, "image_url": ""})
	if err != nil {
		return err
	}
	var errs []error
	for _, item := range items {
		item.Set("image_url", path)
		if err := app.SaveNoValidate(item); err != nil {
			errs = append(errs, fmt.Errorf("item %s: %w", item.Id, err))
		}
	}
	return errors.Join(errs...)
}

// RetryPhotos tries again the photos whose download failed for a reason that
// can pass, for PhotoRetryWindow after their lookup, a few per run and one at
// a time, so a slow photo host is not met with all of them at once.
func RetryPhotos(app core.App) error {
	rows, err := app.FindRecordsByFilter("barcode_cache",
		"found = true && image_url != '' && photo = '' && fetched_at > {:since}",
		"-fetched_at", photoRetryBatch, 0,
		dbx.Params{"since": time.Now().Add(-PhotoRetryWindow).UTC().Format(types.DefaultDateLayout)})
	if err != nil {
		return err
	}
	for _, rec := range rows {
		<-downloadPhoto(app, rec.GetString("barcode"), rec.GetString("image_url"))
	}
	return nil
}

// Product is a product put into the cache without a lookup, photo included:
// the demo build's examples ([D-234]), which must show with no network.
type Product struct {
	Name, NameDE, NameEN string
	CategorySlug         string
	// ImageURL is the photo's upstream address, kept as a lookup keeps it.
	ImageURL string
	Photo    []byte
	PhotoExt string
}

// Store writes p onto the barcode's cache row as a fresh lookup would.
func Store(app core.App, ean string, p Product) error {
	_, err := saveCache(app, ean, &fetchedProduct{
		Name: p.Name, NameDE: p.NameDE, NameEN: p.NameEN, CategorySlug: p.CategorySlug,
		UpstreamImageURL: p.ImageURL, PhotoBytes: p.Photo, PhotoExt: p.PhotoExt,
	})
	return err
}
