package barcode

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

// [D-21]: OFF is the index. A barcode held by a sister site costs exactly two
// requests — OFF, then the site OFF named — and no other site is asked.
func TestLookupFollowsOFFToTheSisterSite(t *testing.T) {
	for _, test := range []struct {
		home         string
		wantCategory string
	}{
		// The fake always tags the product "en:sunscreen". A site with a fixed
		// aisle overrides that; Open Products Facts spans aisles and maps it.
		{"beauty", "personal_care"},
		{"petfood", "pet"},
		{"product", "personal_care"},
	} {
		t.Run(test.home, func(t *testing.T) {
			up := newUpstream(t)
			up.home = test.home
			_, mux, token := barcodeMux(t)

			res, body := lookup(t, mux, token, "4008429081767")
			if res.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
			}
			if body.Name != "Testprodukt" || body.CategorySlug != test.wantCategory {
				t.Errorf("body = %+v, want Testprodukt in %s", body, test.wantCategory)
			}
			if body.ImageURL == "" || up.photoCount() != 1 {
				t.Errorf("image_url = %q, photo hits = %d; want the sister site's photo stored", body.ImageURL, up.photoCount())
			}
			for site, hits := range up.siteCounts() {
				if site != offKey && site != test.home {
					t.Errorf("%s was asked %d times; only OFF and %s should be", site, hits, test.home)
				}
			}
			if up.siteCounts()[offKey] != 1 || up.siteCounts()[test.home] != 1 {
				t.Errorf("site hits = %v, want one each for OFF and %s", up.siteCounts(), test.home)
			}
		})
	}
}

// A plain miss is answered by OFF alone — one request, where the sequential
// OFF-then-OBF loop this replaced spent two — and it is negative-cached.
func TestPlainMissAsksOnlyOFF(t *testing.T) {
	for _, test := range []struct{ name, home string }{
		{"product_not_found", ""},
		// OFF names a product type we have no site for: still an answer.
		{"unknown product type", "cosmetics-v2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			up := newUpstream(t)
			up.home = test.home
			app, mux, token := barcodeMux(t)

			if res, _ := lookup(t, mux, token, "4000000000017"); res.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", res.Code)
			}
			if len(up.siteCounts()) != 1 || up.siteCounts()[offKey] != 1 {
				t.Errorf("site hits = %v, want exactly one request, to OFF", up.siteCounts())
			}
			rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4000000000017"})
			if err != nil {
				t.Fatalf("the miss was not cached: %v", err)
			}
			if rec.GetBool("found") {
				t.Error("a miss was cached as found")
			}
		})
	}
}

// OFF naming a sister site that then fails has answered nothing about the
// product, so — as for an OFF outage — nothing may be negative-cached.
func TestSisterSiteOutageIsNotCached(t *testing.T) {
	up := newUpstream(t)
	up.home = "petfood"
	up.productCode = http.StatusBadGateway
	app, mux, token := barcodeMux(t)

	if res, _ := lookup(t, mux, token, "4008429081767"); res.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (upstream unavailable)", res.Code)
	}
	if _, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4008429081767"}); err == nil {
		t.Error("a sister-site outage was written to barcode_cache")
	}
}

// An outage keeps its cause for the server log: which site, and what it
// answered.
func TestUpstreamOutageNamesItsCause(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	t.Cleanup(srv.Close)

	_, err := queryUpstream(upstreamSite{URL: srv.URL + "/product/%s"}, "4008429081767")
	if !errors.Is(err, errUpstreamUnavailable) {
		t.Fatalf("err = %v, want errUpstreamUnavailable", err)
	}
	if want := srv.URL + "/product/4008429081767 answered 429 Too Many Requests"; !strings.Contains(err.Error(), want) {
		t.Errorf("err = %q, want it to name %q", err, want)
	}
}

// Every site's photos come from its own CDN; a host missing here would store
// the product with no picture, silently.
func TestEverySiteHasAnAllowedPhotoHost(t *testing.T) {
	for _, host := range []string{
		"images.openfoodfacts.org",
		"images.openbeautyfacts.org",
		"images.openpetfoodfacts.org",
		"images.openproductsfacts.org",
	} {
		if !allowedPhotoHost(host) {
			t.Errorf("%s is not in photoHosts", host)
		}
	}
}

// Open Food Facts asks every API client to name itself; Go's default
// "Go-http-client/1.1" names nobody.
func TestUpstreamRequestsNameTheApp(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("User-Agent")
	}))
	t.Cleanup(srv.Close)
	old := userAgent
	t.Cleanup(func() { userAgent = old })

	SetUserAgent("v1.2.3", "https://example.org/src")
	resp, err := upstreamGet(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if want := "shoppinglist/v1.2.3 (+https://example.org/src)"; got != want {
		t.Errorf("User-Agent = %q, want %q", got, want)
	}
}
