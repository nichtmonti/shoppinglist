package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(barcodeCachePhotoUp, barcodeCachePhotoDown, "1778000005_barcode_cache_photo.go")
}

// [D-21]: product photos are stored on the server and served from our own
// origin instead of hot-linking the OFF/OBF image CDN. Two fields carry that:
//
//   - photo: the image bytes themselves. MaxSize is 512 KiB against a measured
//     ~20-37 KiB for the `.400` variant OFF returns, so it is a guard against a
//     hostile/broken upstream rather than a working limit.
//   - photo_token: the unguessable path segment the photo is served under. It
//     exists because the serving route CANNOT be authenticated — an <img src>
//     sends no Authorization header, and the auth token lives in IndexedDB
//     (§5.6), not a cookie. Keying the URL on the barcode would make
//     "has this household scanned <product>?" enumerable by anyone; keying it
//     on the PocketBase record id would lean on core.GenerateDefaultRandomId,
//     which is math/rand/v2 and documented upstream as "not intended for
//     security purposes". So the route gets its own 128-bit crypto/rand token.
//   - photo_hash: sha256 of the stored bytes, so a refetch that returns the same
//     photo KEEPS the existing token. items.image_url holds that token URL and
//     syncs to every member, so rotating it on every refetch would blank the
//     picture on every already-created item each time the 30-day TTL lapsed.
func barcodeCachePhotoUp(app core.App) error {
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		return err
	}
	// Partial, because every row that has no photo carries photo_token = ''
	// and a plain UNIQUE index would collide on the second such row.
	c.Indexes = append(c.Indexes,
		"CREATE UNIQUE INDEX `idx_barcode_cache_photo_token` ON `barcode_cache` (`photo_token`) WHERE `photo_token` != ''")
	c.Fields.Add(
		&core.FileField{
			Name:      "photo",
			MaxSelect: 1,
			MaxSize:   512 << 10,
			MimeTypes: []string{"image/jpeg", "image/png", "image/webp"},
			// Protected is what keeps PocketBase's OWN file route out of the
			// picture. apis/file.go binds GET /api/files/{collection}/{recordId}/
			// {filename} unconditionally and only checks authorization when the
			// field is protected — so leaving this false would publish every photo
			// on a second, unauthenticated route that bypasses the 128-bit token
			// and the barcode_photo rate-limit budget, sets its own Cache-Control
			// and offers server-side ?thumb= resizing, guarded only by the math/rand/v2 record
			// id this design specifically refuses to rely on. The app serves photos
			// off the filesystem directly (photoHandler), so nothing legitimate
			// needs that route.
			Protected: true,
		},
		&core.TextField{Name: "photo_token"},
		&core.TextField{Name: "photo_hash"},
	)
	return app.Save(c)
}

func barcodeCachePhotoDown(app core.App) error {
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		return err
	}
	// Only the index this migration added; the unique barcode index is
	// 1778000001's.
	c.RemoveIndex("idx_barcode_cache_photo_token")
	c.Fields.RemoveByName("photo")
	c.Fields.RemoveByName("photo_token")
	c.Fields.RemoveByName("photo_hash")
	return app.Save(c)
}
