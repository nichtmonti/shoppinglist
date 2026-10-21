// Package barcode provides the authenticated barcode lookup proxy with its
// persistent upstream cache, the product photos that cache stores and serves
// ([D-21]), and the sweep that bounds them.
package barcode

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/security"
	"shoppinglist/internal/settings"
)

var barcodePattern = regexp.MustCompile(`^[0-9]{8,14}$`)

// product is the wire shape returned to the client. ImageURL is empty or a
// path under photoPathPrefix, never an upstream URL, which lets the CSP pin
// img-src to 'self' ([D-21]).
type product struct {
	Name string `json:"name"`
	// NameDE/NameEN let each member read the item in their language ([D-21]).
	NameDE       string `json:"name_de,omitempty"`
	NameEN       string `json:"name_en,omitempty"`
	ImageURL     string `json:"image_url"`
	CategorySlug string `json:"category_slug"`
}

// ScannerEnv switches the barcode scanner off for a deployment ([D-218]).
const ScannerEnv = settings.ScannerEnv

// RegisterRoutes mounts GET /api/barcode/{ean}, cached server-side, and the
// photo route it points at.
func RegisterRoutes(r *router.RouterGroup[*core.RequestEvent]) {
	security.AuthRoutes(r).GET("/api/barcode/{ean}", lookupHandler).BindFunc(security.RateLimit(security.RateBarcodeLookup))
	RegisterPhotoRoute(r)
}

// RegisterPhotoRoute mounts only the photo route, which a deployment with the
// scanner off ([D-218]) keeps so earlier items' pictures still render. It is
// unauthenticated, guarded by its 128-bit token instead ([D-21]).
func RegisterPhotoRoute(r *router.RouterGroup[*core.RequestEvent]) {
	r.GET(photoPathPrefix+"{token}", photoHandler).BindFunc(security.RateLimit(security.RateBarcodePhoto))
}

func lookupHandler(e *core.RequestEvent) error {
	ean := strings.TrimSpace(e.Request.PathValue("ean"))
	if !barcodePattern.MatchString(ean) {
		return e.BadRequestError("invalid barcode", nil)
	}
	// The caller's UI language picks among the cached names ([D-21]); it is
	// not part of the cache key.
	lang := e.Request.URL.Query().Get("lang")

	cached, err := findCache(e.App, ean)
	if err != nil {
		return e.InternalServerError("failed to read barcode cache", err)
	}
	hit := cached != nil && cached.GetBool("found")
	if cached != nil {
		maxAge := negativeCacheTTL
		if hit && !photoMissed(cached) {
			maxAge = positiveCacheTTL
		}
		if age := time.Since(cached.GetDateTime("fetched_at").Time()); age >= 0 && age < maxAge {
			if !hit {
				return e.NotFoundError("barcode not found", nil)
			}
			return e.JSON(http.StatusOK, productFromRecord(cached, lang))
		}
	}

	found, err := fetchProduct(ean)
	if err != nil {
		// An expired hit still names the product better than a failure: the
		// server has its name, photo and aisle. fetched_at stays, so the next
		// scan asks upstream again.
		if hit {
			return e.JSON(http.StatusOK, productFromRecord(cached, lang))
		}
		return e.InternalServerError("barcode service unavailable", err)
	}
	rec, err := saveCache(e.App, ean, found)
	if err != nil {
		return e.InternalServerError("failed to cache barcode result", err)
	}
	if found == nil {
		return e.NotFoundError("barcode not found", nil)
	}
	// The photo, a new one or the same bytes again, is waited for only
	// briefly; the answer is the row as it stands then, with the photo if it
	// came in time.
	if url := rec.GetString("image_url"); url != "" {
		select {
		case <-downloadPhoto(e.App, ean, url):
		case <-time.After(photoWait):
		}
		if fresh, err := findCache(e.App, ean); err == nil && fresh != nil {
			rec = fresh
		}
	}
	return e.JSON(http.StatusOK, productFromRecord(rec, lang))
}

// issuedPhotoPath is the photo route's path for a cache row's stored photo,
// "" for none: never the stored upstream URL ([D-21]).
func issuedPhotoPath(rec *core.Record) string {
	if token := rec.GetString("photo_token"); token != "" && rec.GetString("photo") != "" {
		return photoPathPrefix + token
	}
	return ""
}

// Register binds the items hook that stamps image_url from the barcode
// ([D-266]) on every save through the record pipeline (push, import and
// clone, the superuser dashboard), so no client chooses an item's photo. The
// photo is looked up on a create and when the barcode differs from the row as
// loaded, so a save that leaves the barcode keeps the photo it has.
func Register(app core.App) {
	stamp := func(e *core.RecordEvent) error {
		if rec := e.Record; rec.IsNew() || rec.GetString("barcode") != rec.Original().GetString("barcode") {
			path, err := photoPath(e.App, rec.GetString("barcode"))
			if err != nil {
				return err
			}
			rec.Set("image_url", path)
		}
		return e.Next()
	}
	app.OnRecordCreateExecute("items").BindFunc(stamp)
	app.OnRecordUpdateExecute("items").BindFunc(stamp)
}

// photoPath is the photo an item with barcode ean shows: the path the lookup
// issued for that product's stored photo, or "" when the server holds none.
func photoPath(app core.App, ean string) (string, error) {
	if ean == "" {
		return "", nil
	}
	rec, err := findCache(app, ean)
	if err != nil || rec == nil {
		return "", err
	}
	return issuedPhotoPath(rec), nil
}

// productFromRecord renders a found cache row as the wire product, named in
// lang where the upstream had that name, else in the product's main language.
func productFromRecord(rec *core.Record, lang string) *product {
	imageURL := issuedPhotoPath(rec)
	name := rec.GetString("name")
	// lang is client input, so only the two known values select a column.
	if lang == "de" || lang == "en" {
		if localized := rec.GetString("name_" + lang); localized != "" {
			name = localized
		}
	}
	return &product{
		Name: name, NameDE: rec.GetString("name_de"), NameEN: rec.GetString("name_en"),
		ImageURL: imageURL, CategorySlug: rec.GetString("category_slug"),
	}
}
