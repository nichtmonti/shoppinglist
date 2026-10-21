package barcode

import (
	"errors"
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// SweepPhotos drops barcode_cache entries untouched for 180 days, which bounds
// pb_data growth from stored product photos ([D-21]).
//
// It skips a row whose photo an item still points at (§9.2), tombstones
// included since they can be restored (§8.2). The reference test is equality
// with the issued URL, not a suffix match: the server stamps image_url from
// the barcode ([D-266]), and the exact match still holds for a dashboard edit
// or a row from before that, where a suffix would pin a row forever.
// Rows are deleted through app.Delete, not raw SQL, so PocketBase's hooks
// remove the files too.
//
// A row that fails to delete does not stop the others; every failure is
// returned, joined.
func SweepPhotos(app core.App) error {
	rows, err := app.FindAllRecords("barcode_cache", dbx.NewExp(
		`fetched_at != '' AND fetched_at < datetime('now','-180 days') `+
			`AND (photo_token = '' OR NOT EXISTS (`+
			`SELECT 1 FROM items `+
			`WHERE items.image_url = {:prefix} || barcode_cache.photo_token))`,
		dbx.Params{"prefix": photoPathPrefix}))
	if err != nil {
		return err
	}
	var errs []error
	for _, rec := range rows {
		if err := app.Delete(rec); err != nil {
			errs = append(errs, fmt.Errorf("barcode_cache %s: %w", rec.Id, err))
		}
	}
	return errors.Join(errs...)
}

// photoShown reports whether an item, tombstones included, holds exactly the
// URL issued for token: the same equality test as SweepPhotos.
func photoShown(app core.App, token string) (bool, error) {
	n, err := app.CountRecords("items", dbx.HashExp{"image_url": photoPathPrefix + token})
	return n > 0, err
}
