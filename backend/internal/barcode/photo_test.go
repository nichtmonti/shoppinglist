package barcode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// onePixelPNG is a valid 1x1 PNG — http.DetectContentType sniffs the magic
// number, so the bytes have to be a real image, not a placeholder string.
var onePixelPNG = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 'I', 'D', 'A', 'T',
	0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
	0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
	0x00, 0x00, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82,
}

// upstream stands in for all four Open Food Facts sites: each answers the v3
// product JSON under /<site>/product/, and every photo is served at /photo. It
// is a TLS server because fetchPhoto requires https, and the test points
// upstreamClient at its cert rather than relaxing that.
//
// home is the site that holds the product, or "" for none. Asked anywhere
// else, OFF answers the way the real one does for a sister site's barcode — a
// 404 naming home's product_type — and every other answer is a plain
// product_not_found.
type upstream struct {
	server    *httptest.Server
	home      string
	name      string
	nameDE    string
	nameEN    string
	photoBody []byte
	photoType string
	photoCode int
	// photoDelay, when set, is how long /photo waits before it answers.
	photoDelay time.Duration
	// mu guards photoHits and siteHits: the lookup asks the sites at once, so
	// the handlers write them from several goroutines. Read them through
	// photoCount and siteCounts.
	mu        sync.Mutex
	photoHits int
	// photoRedirect, when set, is where /photo redirects instead of serving.
	photoRedirect string
	productCode   int
	// productHTML, when set, makes home answer 200 with an HTML page, the
	// way a captive portal or an error page behind a proxy does.
	productHTML bool
	siteHits    map[string]int
}

// offKey names OFF among the fake's sites; the rest are siblingSites' keys.
const offKey = "food"

func newUpstream(t *testing.T) *upstream {
	t.Helper()
	u := &upstream{
		home: offKey, name: "Testprodukt", photoBody: onePixelPNG, photoType: "image/png",
		photoCode: http.StatusOK, productCode: http.StatusOK, siteHits: map[string]int{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/photo", func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.photoHits++
		u.mu.Unlock()
		if u.photoDelay > 0 {
			time.Sleep(u.photoDelay)
		}
		if u.photoRedirect != "" {
			http.Redirect(w, r, u.photoRedirect, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", u.photoType)
		w.WriteHeader(u.photoCode)
		_, _ = w.Write(u.photoBody)
	})
	mux.HandleFunc("/{site}/product/{code}", func(w http.ResponseWriter, r *http.Request) {
		site := r.PathValue("site")
		u.mu.Lock()
		u.siteHits[site]++
		u.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case site == u.home && u.productHTML:
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, `<!doctype html><html><body>Please accept the terms of use</body></html>`)
		case site == u.home && u.productCode != http.StatusOK:
			w.WriteHeader(u.productCode)
		case site == u.home:
			_, _ = fmt.Fprintf(w, `{"product":{"product_name":%q,"product_name_de":%q,"product_name_en":%q,`+
				`"image_url":%q,"categories_tags":["en:sunscreen"]},"result":{"id":"product_found"},"status":"success"}`,
				u.name, u.nameDE, u.nameEN, u.server.URL+"/photo")
		case site == offKey && u.home != "":
			w.WriteHeader(http.StatusNotFound)
			_, _ = fmt.Fprintf(w, `{"errors":[{"field":{"id":"product_type","value":%q}}],`+
				`"result":{"id":"product_found_with_a_different_product_type"},"status":"failure"}`, u.home)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = fmt.Fprint(w, `{"result":{"id":"product_not_found"},"status":"failure"}`)
		}
	})
	u.server = httptest.NewTLSServer(mux)
	t.Cleanup(u.server.Close)

	host := mustHost(t, u.server.URL)

	// Swap the package-level upstream wiring for the duration of the test —
	// EVERY site, so no test can reach the real network. The allowlist gains
	// the test host rather than being bypassed, so the allowlist itself stays
	// on the tested path.
	oldOff, oldSiblings, oldHosts, oldTransport := offSite, siblingSites, photoHosts, upstreamClient.Transport
	offSite = upstreamSite{URL: u.server.URL + "/" + offKey + "/product/%s"}
	siblingSites = map[string]upstreamSite{}
	for key, site := range oldSiblings {
		site.URL = u.server.URL + "/" + key + "/product/%s"
		siblingSites[key] = site
	}
	photoHosts = append([]string{host}, photoHosts...)
	upstreamClient.Transport = u.server.Client().Transport
	t.Cleanup(func() {
		offSite, siblingSites, photoHosts = oldOff, oldSiblings, oldHosts
		upstreamClient.Transport = oldTransport
	})
	return u
}

func (u *upstream) photoCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.photoHits
}

// siteCounts is a copy of the requests each site has had.
func (u *upstream) siteCounts() map[string]int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return maps.Clone(u.siteHits)
}

// expireCache backdates the row so the next lookup refetches rather than
// serving the 30-day positive cache.
func expireCache(t *testing.T, app core.App, ean string) {
	t.Helper()
	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": ean})
	if err != nil {
		t.Fatal(err)
	}
	rec.Set("fetched_at", "2020-01-01 00:00:00.000Z")
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.Host
}

func lookup(t *testing.T, mux http.Handler, token, ean string) (*httptest.ResponseRecorder, product) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/barcode/"+ean, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	var body product
	_ = json.Unmarshal(res.Body.Bytes(), &body)
	return res, body
}

// The whole point of [D-21]: what the client is told to render is a path on our
// own origin, and the bytes are actually there. If this passes, img-src can be
// 'self' and no member's browser ever contacts the OFF/OBF CDN.
func TestLookupStoresPhotoAndServesItFromOurOrigin(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	res, body := lookup(t, mux, token, "4006381333931")
	if res.Code != http.StatusOK {
		t.Fatalf("lookup status = %d: %s", res.Code, res.Body.String())
	}
	if !strings.HasPrefix(body.ImageURL, photoPathPrefix) {
		t.Fatalf("image_url = %q, want a %s path", body.ImageURL, photoPathPrefix)
	}
	if strings.Contains(body.ImageURL, up.server.URL) || strings.Contains(body.ImageURL, "openfoodfacts") {
		t.Fatalf("image_url leaked the upstream URL: %q", body.ImageURL)
	}

	photoReq := httptest.NewRequest(http.MethodGet, body.ImageURL, nil)
	photoRes := httptest.NewRecorder()
	mux.ServeHTTP(photoRes, photoReq)
	if photoRes.Code != http.StatusOK {
		t.Fatalf("photo status = %d: %s", photoRes.Code, photoRes.Body.String())
	}
	if !bytes.Equal(photoRes.Body.Bytes(), onePixelPNG) {
		t.Errorf("photo body = %d bytes, want the %d stored", photoRes.Body.Len(), len(onePixelPNG))
	}
	if cc := photoRes.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable", cc)
	}

	// The upstream photo is fetched once, on the cache miss — never per view.
	if _, second := lookup(t, mux, token, "4006381333931"); second.ImageURL != body.ImageURL {
		t.Errorf("second lookup image_url = %q, want the cached %q", second.ImageURL, body.ImageURL)
	}
	if up.photoCount() != 1 {
		t.Errorf("upstream photo hits = %d, want 1", up.photoCount())
	}

	// Provenance is retained server-side, but never handed to a browser.
	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rec.GetString("image_url"), up.server.URL) {
		t.Errorf("stored upstream image_url = %q, want the upstream URL", rec.GetString("image_url"))
	}
}

// The photo route is the app's only unauthenticated endpoint, so what it
// refuses matters as much as what it serves.
func TestPhotoRouteRejectsUnknownAndMalformedTokens(t *testing.T) {
	newUpstream(t)
	_, mux, _ := barcodeMux(t)

	for _, test := range []struct {
		name string
		path string
	}{
		{"unknown but well-formed", photoPathPrefix + strings.Repeat("a", 32)},
		{"too short", photoPathPrefix + "abc"},
		{"not hex", photoPathPrefix + strings.Repeat("z", 32)},
		{"sql-ish", photoPathPrefix + "'OR1=1--"},
		{"path traversal", photoPathPrefix + "..%2F..%2Fetc%2Fpasswd"},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			res := httptest.NewRecorder()
			mux.ServeHTTP(res, req)
			if res.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404: %s", res.Code, res.Body.String())
			}
		})
	}
}

// [D-191] A photo the server cannot read is not "not found", and no failure
// carries the success's year-long Cache-Control: one storage hiccup would
// blank the picture on that device for a year.
func TestPhotoRouteFailuresAreNotCached(t *testing.T) {
	newUpstream(t)
	app, mux, token := barcodeMux(t)
	_, body := lookup(t, mux, token, "4006381333931")
	get := func() *httptest.ResponseRecorder {
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, httptest.NewRequest(http.MethodGet, body.ImageURL, nil))
		return res
	}

	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = '4006381333931'")
	if err != nil {
		t.Fatal(err)
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	if err := fsys.Delete(rec.BaseFilesPath() + "/" + rec.GetString("photo")); err != nil {
		t.Fatal(err)
	}
	if res := get(); res.Code != http.StatusNotFound || res.Header().Get("Cache-Control") != "" {
		t.Errorf("missing file = %d with Cache-Control %q, want 404 and none", res.Code, res.Header().Get("Cache-Control"))
	}

	if _, err := app.DB().NewQuery("DROP TABLE barcode_cache").Execute(); err != nil {
		t.Fatal(err)
	}
	if res := get(); res.Code != http.StatusInternalServerError || res.Header().Get("Cache-Control") != "" {
		t.Errorf("unreadable cache = %d with Cache-Control %q, want 500 and none", res.Code, res.Header().Get("Cache-Control"))
	}
}

// A token is 128 crypto/rand bits and is minted fresh on every store, so two
// products never collide and one photo's URL says nothing about another's.
func TestPhotoTokensAreDistinctAndWellFormed(t *testing.T) {
	newUpstream(t)
	_, mux, token := barcodeMux(t)

	_, first := lookup(t, mux, token, "4006381333931")
	_, second := lookup(t, mux, token, "3017620422003")

	if first.ImageURL == second.ImageURL {
		t.Fatalf("two products share a photo URL: %q", first.ImageURL)
	}
	for _, got := range []string{first.ImageURL, second.ImageURL} {
		if !photoTokenPattern.MatchString(strings.TrimPrefix(got, photoPathPrefix)) {
			t.Errorf("token in %q does not match %s", got, photoTokenPattern)
		}
	}
}

// A photo we will not store must not degrade the lookup: the name and category
// are the useful part, and §9.1 renders the category emoji when there is no
// picture. Every case here must yield a 200 with an empty image_url — never a
// fallback to the upstream URL, which would put a third-party host back into
// img-src.
func TestPhotoRejectionsLeaveTheLookupUsable(t *testing.T) {
	for _, test := range []struct {
		name  string
		apply func(*upstream)
	}{
		{"oversized", func(u *upstream) {
			u.photoBody = append(onePixelPNG, bytes.Repeat([]byte{0x42}, maxPhotoBytes)...)
		}},
		{"not an image", func(u *upstream) {
			u.photoBody, u.photoType = []byte("<!doctype html><html>nope</html>"), "text/html"
		}},
		{"upstream error", func(u *upstream) { u.photoCode = http.StatusInternalServerError }},
		{"empty body", func(u *upstream) { u.photoBody = nil }},
	} {
		t.Run(test.name, func(t *testing.T) {
			up := newUpstream(t)
			test.apply(up)
			_, mux, token := barcodeMux(t)

			res, body := lookup(t, mux, token, "4006381333931")
			if res.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
			}
			if body.Name != "Testprodukt" {
				t.Errorf("name = %q, want the product to survive a photo failure", body.Name)
			}
			if body.ImageURL != "" {
				t.Errorf("image_url = %q, want empty", body.ImageURL)
			}
		})
	}
}

// fetchPhoto is the one outbound request whose URL comes from a response body.
// The allowlist is what keeps that from being an SSRF primitive, so it is
// tested directly rather than only through the route.
func TestFetchPhotoRefusesDisallowedTargets(t *testing.T) {
	up := newUpstream(t)
	for _, test := range []struct {
		name string
		url  string
	}{
		{"empty", ""},
		{"plaintext http", "http://images.openfoodfacts.org/x.jpg"},
		{"loopback", "https://127.0.0.1:1/x.jpg"},
		{"link-local metadata", "https://169.254.169.254/latest/meta-data/"},
		{"lookalike suffix", "https://images.openfoodfacts.org.evil.test/x.jpg"},
		{"lookalike prefix", "https://evilimages.openfoodfacts.org/x.jpg"},
		{"not a url", "://"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := fetchPhoto(test.url); got.data != nil || got.retry {
				t.Fatalf("fetchPhoto(%q) = %d bytes, retry %v; want nothing, for good", test.url, len(got.data), got.retry)
			}
		})
	}
	if up.photoCount() != 0 {
		t.Errorf("upstream was contacted %d times for disallowed URLs", up.photoCount())
	}
}

// [D-21] A photo host that redirects is not followed: the allowlist checks
// the URL fetchPhoto is given, so a followed redirect would fetch whatever
// address the upstream names. The target here is plain HTTP the client can
// reach, so only the refused redirect keeps it from being fetched.
func TestFetchPhotoDoesNotFollowRedirects(t *testing.T) {
	up := newUpstream(t)
	targetHits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHits++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(onePixelPNG)
	}))
	t.Cleanup(target.Close)
	up.photoRedirect = target.URL + "/x.png"

	if got := fetchPhoto(up.server.URL + "/photo"); got.data != nil || got.retry {
		t.Errorf("fetchPhoto through a redirect = %d bytes, retry %v; want nothing, for good", len(got.data), got.retry)
	}
	if up.photoCount() != 1 || targetHits != 0 {
		t.Errorf("photo host hits = %d, redirect target hits = %d; want 1 and 0", up.photoCount(), targetHits)
	}
}

// The two ways a lookup can fail to produce a product are NOT the same thing,
// and the difference is what protects every item already carrying a photo URL.
//
// A transport failure (here: the upstream server closed) is an outage, not
// "product gone": treating it as one would let a 30-second OFF outage
// negative-cache a live product and destroy the token every existing item
// points at.
func TestUpstreamOutageNeitherCachesNorDestroysThePhoto(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	_, first := lookup(t, mux, token, "4006381333931")
	if first.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}
	expireCache(t, app, "4006381333931")

	// Every upstream unreachable: this answers nothing, so it must not be
	// written down as an answer.
	up.server.Close()
	res, _ := lookup(t, mux, token, "4006381333931")
	if res.Code == http.StatusNotFound {
		t.Error("an outage was negative-cached as 'barcode not found'")
	}

	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}
	if !rec.GetBool("found") || rec.GetString("name") == "" {
		t.Error("the cached product was overwritten by an outage")
	}
	if got := photoPathPrefix + rec.GetString("photo_token"); got != first.ImageURL {
		t.Errorf("photo token changed to %q during an outage, want %q — every existing item just 404'd",
			got, first.ImageURL)
	}

	// And the already-issued URL still serves bytes.
	photoRes := httptest.NewRecorder()
	mux.ServeHTTP(photoRes, httptest.NewRequest(http.MethodGet, first.ImageURL, nil))
	if photoRes.Code != http.StatusOK {
		t.Errorf("photo status = %d during an outage, want 200", photoRes.Code)
	}
}

// A 2xx whose body is not the product JSON (a captive portal's 200 <html>)
// has answered nothing about the product either: the lookup answers as an
// outage does, a barcode never seen gets no negative-cache row, and a known
// one keeps its row and photo.
func TestUpstreamHTMLPageIsAnOutageNotAMiss(t *testing.T) {
	t.Run("unknown barcode", func(t *testing.T) {
		up := newUpstream(t)
		up.productHTML = true
		app, mux, token := barcodeMux(t)

		if res, _ := lookup(t, mux, token, "4006381333931"); res.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500 (upstream unavailable)", res.Code)
		}
		if rec, _ := findCache(app, "4006381333931"); rec != nil {
			t.Error("an HTML page was written to barcode_cache as an answer")
		}
	})
	t.Run("known barcode", func(t *testing.T) {
		up := newUpstream(t)
		app, mux, token := barcodeMux(t)

		_, first := lookup(t, mux, token, "4006381333931")
		if first.ImageURL == "" {
			t.Fatal("setup: expected a stored photo")
		}
		expireCache(t, app, "4006381333931")

		up.productHTML = true
		res, body := lookup(t, mux, token, "4006381333931")
		if res.Code != http.StatusOK || body.Name != first.Name || body.ImageURL != first.ImageURL {
			t.Fatalf("lookup = %d %+v, want the cached %+v", res.Code, body, first)
		}
		rec, err := findCache(app, "4006381333931")
		if err != nil || rec == nil {
			t.Fatal("no cache row", err)
		}
		if !rec.GetBool("found") || photoPathPrefix+rec.GetString("photo_token") != first.ImageURL {
			t.Errorf("the cached product was overwritten by an HTML page: found=%v token=%q",
				rec.GetBool("found"), rec.GetString("photo_token"))
		}
		if got := rec.GetString("fetched_at"); !strings.HasPrefix(got, "2020-01-01") {
			t.Errorf("fetched_at = %q: an HTML page must not count as a fresh answer", got)
		}
	})
}

// A genuine upstream 404 IS an answer: it gets negative-cached. The photo still
// survives, because the items pointing at it did nothing wrong — a product being
// delisted upstream must not blank the picture on someone's shopping list.
func TestGenuineNotFoundIsCachedButKeepsThePhoto(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	_, first := lookup(t, mux, token, "4006381333931")
	if first.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}
	expireCache(t, app, "4006381333931")

	up.productCode = http.StatusNotFound
	if res, _ := lookup(t, mux, token, "4006381333931"); res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 once the upstream says the product is gone", res.Code)
	}

	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}
	if rec.GetBool("found") {
		t.Error("a genuine 404 was not negative-cached")
	}
	photoRes := httptest.NewRecorder()
	mux.ServeHTTP(photoRes, httptest.NewRequest(http.MethodGet, first.ImageURL, nil))
	if photoRes.Code != http.StatusOK {
		t.Errorf("photo status = %d, want 200 — existing items lost their picture because a product was delisted", photoRes.Code)
	}
}

// PocketBase binds GET /api/files/{collection}/{recordId}/{filename} for every
// collection and only authorizes it when the field is Protected. Unprotected,
// that is a SECOND unauthenticated route onto every photo — one that bypasses
// the 128-bit token, bypasses RateBarcodePhoto, and offers ?thumb= resizing, behind
// nothing but a math/rand/v2 record id.
func TestPocketBaseFileRouteDoesNotServePhotos(t *testing.T) {
	newUpstream(t)
	app, _, token := barcodeMux(t)

	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	RegisterRoutes(security.AppRoutes(r))
	full, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	if _, body := lookup(t, full, token, "4006381333931"); body.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}
	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/files/barcode_cache/" + rec.Id + "/" + rec.GetString("photo")
	res := httptest.NewRecorder()
	full.ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
	if res.Code == http.StatusOK {
		t.Errorf("%s served %d bytes to an anonymous caller — the photo has a second, untokened public route",
			path, res.Body.Len())
	}
}

// The stored filename rides Content-Disposition to anyone holding the photo URL.
// Naming the file after the barcode would hand them the exact product, which is
// the enumeration leak the token exists to prevent.
func TestStoredFilenameDoesNotLeakTheBarcode(t *testing.T) {
	newUpstream(t)
	app, mux, token := barcodeMux(t)

	_, body := lookup(t, mux, token, "4006381333931")
	if body.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}
	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.GetString("photo"), "4006381333931") {
		t.Errorf("stored filename %q contains the EAN", rec.GetString("photo"))
	}

	res := httptest.NewRecorder()
	mux.ServeHTTP(res, httptest.NewRequest(http.MethodGet, body.ImageURL, nil))
	if cd := res.Header().Get("Content-Disposition"); strings.Contains(cd, "4006381333931") {
		t.Errorf("Content-Disposition %q leaks the EAN to any holder of the URL", cd)
	}
}

// The unauthenticated route looks up by photo_token on every request, including
// every rejected one. Without an index that is a full scan of the cache table,
// which is a free DB-CPU amplifier for an anonymous caller.
func TestPhotoTokenIsIndexed(t *testing.T) {
	app, _, _ := barcodeMux(t)
	var idx []struct{ Sql string }
	if err := app.DB().NewQuery(
		"SELECT COALESCE(sql, '') AS sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'barcode_cache'",
	).All(&idx); err != nil {
		t.Fatal(err)
	}
	for _, row := range idx {
		if strings.Contains(row.Sql, "photo_token") {
			return
		}
	}
	t.Errorf("no index on barcode_cache.photo_token; found %v", idx)
}

// items.image_url stores the photo's token URL and syncs to every member, so a
// token that rotated on every refetch would blank the picture on every
// already-created item each time the 30-day TTL lapsed. Unchanged bytes must
// keep the URL; changed bytes must not (the route serves `immutable`, so a
// reused token would pin the stale image in every client cache forever).
func TestPhotoTokenIsStableUnlessTheImageChanges(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	_, first := lookup(t, mux, token, "4006381333931")
	if first.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}

	expireCache(t, app, "4006381333931")
	_, same := lookup(t, mux, token, "4006381333931")
	if same.ImageURL != first.ImageURL {
		t.Errorf("URL rotated on an unchanged photo: %q -> %q — every existing item just lost its picture",
			first.ImageURL, same.ImageURL)
	}
	if up.photoCount() != 2 {
		t.Fatalf("upstream photo hits = %d, want 2 (the refetch must actually happen)", up.photoCount())
	}

	// A genuinely different photo must rotate, or clients keep the old bytes
	// forever behind the immutable Cache-Control.
	up.photoBody = append(append([]byte{}, onePixelPNG...), 0x00)
	expireCache(t, app, "4006381333931")
	_, changed := lookup(t, mux, token, "4006381333931")
	if changed.ImageURL == first.ImageURL {
		t.Errorf("URL survived a changed photo: %q — clients would never see the new image", changed.ImageURL)
	}
}

// TestLookupRetriesAPhotoThatDidNotArrive: a photo upstream names but the
// server could not fetch (Open Food Facts' image host slower than the
// five-second timeout) is asked for again once negativeCacheTTL has passed,
// not after the hit's 30 days, so a slow moment does not leave the product
// without its picture for a month.
func TestLookupRetriesAPhotoThatDidNotArrive(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	up.photoCode = http.StatusServiceUnavailable
	if _, first := lookup(t, mux, token, "4006381333931"); first.Name == "" || first.ImageURL != "" {
		t.Fatalf("first lookup = %+v, want the product without a photo", first)
	}
	up.photoCode = http.StatusOK
	if _, cached := lookup(t, mux, token, "4006381333931"); cached.ImageURL != "" {
		t.Fatalf("within negativeCacheTTL the cached answer stands, got image_url %q", cached.ImageURL)
	}
	if n := up.photoCount(); n != 1 {
		t.Fatalf("upstream photo hits = %d, want 1 before the retry", n)
	}

	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "4006381333931"})
	if err != nil {
		t.Fatal(err)
	}
	rec.Set("fetched_at", time.Now().Add(-negativeCacheTTL-time.Minute))
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
	_, retried := lookup(t, mux, token, "4006381333931")
	if !strings.HasPrefix(retried.ImageURL, photoPathPrefix) {
		t.Fatalf("after negativeCacheTTL, image_url = %q, want the stored photo", retried.ImageURL)
	}
}

// TestPhotoAnItemShowsSurvivesAChangedUpstreamPhoto: items.image_url is never
// reconciled ([D-21]), so rotating the token while an item holds the old URL
// deleted the file behind it, and the item's picture went blank for every
// member. The photo an item shows stays until no item does.
func TestPhotoAnItemShowsSurvivesAChangedUpstreamPhoto(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	_, first := lookup(t, mux, token, "4006381333931")
	list := testutil.CreateList(t, app, "Drogerie")
	testutil.CreateItem(t, app, list, "Sonnencreme", func(r *core.Record) {
		r.Set("image_url", first.ImageURL)
	})

	up.photoBody = append(append([]byte{}, onePixelPNG...), 0x00)
	expireCache(t, app, "4006381333931")
	_, again := lookup(t, mux, token, "4006381333931")
	if again.ImageURL != first.ImageURL {
		t.Errorf("an item's photo URL rotated: %q -> %q", first.ImageURL, again.ImageURL)
	}
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, httptest.NewRequest(http.MethodGet, first.ImageURL, nil))
	if res.Code != http.StatusOK {
		t.Fatalf("the item's photo URL answers %d — its picture is gone", res.Code)
	}
}

// TestExpiredHitAnswersWhileUpstreamIsDown: a product the server already knows
// is named from its cache when the refetch fails, instead of a 500 the app
// shows as „Produkt nicht gefunden“; fetched_at stays, so the next scan tries
// upstream again.
func TestExpiredHitAnswersWhileUpstreamIsDown(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)

	_, first := lookup(t, mux, token, "4006381333931")
	expireCache(t, app, "4006381333931")
	up.productCode = http.StatusServiceUnavailable

	res, body := lookup(t, mux, token, "4006381333931")
	if res.Code != http.StatusOK {
		t.Fatalf("lookup status = %d while upstream is down, want the cached product", res.Code)
	}
	if body.Name != first.Name || body.ImageURL != first.ImageURL {
		t.Errorf("answered %+v, want the cached %+v", body, first)
	}
	rec, err := findCache(app, "4006381333931")
	if err != nil || rec == nil {
		t.Fatal("no cache row", err)
	}
	if got := rec.GetString("fetched_at"); !strings.HasPrefix(got, "2020-01-01") {
		t.Errorf("fetched_at = %q: a failed refetch must not count as fresh", got)
	}
}

// [D-266] photoPath, which the push and import routes stamp items with, is
// exactly the photo path the lookup issued; nothing for a barcode the server
// holds no photo for.
func TestPhotoPathIsWhatTheLookupIssued(t *testing.T) {
	newUpstream(t)
	app, mux, token := barcodeMux(t)
	_, body := lookup(t, mux, token, "4006381333931")
	if body.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}
	for ean, want := range map[string]string{"4006381333931": body.ImageURL, "4000000000000": "", "": ""} {
		if got, err := photoPath(app, ean); err != nil || got != want {
			t.Errorf("photoPath(%q) = %q, %v; want %q", ean, got, err, want)
		}
	}
}

// A cache that cannot be read is a failure, not a miss ([D-191]): the lookup
// answers 500 and asks no upstream, rather than fetching and inserting a row
// beside one it could not see.
func TestLookupAnswers500WhenTheCacheCannotBeRead(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	if _, err := app.DB().NewQuery("DROP TABLE barcode_cache").Execute(); err != nil {
		t.Fatal(err)
	}
	if res, _ := lookup(t, mux, token, "4006381333931"); res.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", res.Code)
	}
	if hits := up.siteCounts(); len(hits) != 0 {
		t.Errorf("upstream asked %v after a failed cache read", hits)
	}
}

// [D-266] Every save of an item, the dashboard's too, stores the photo from
// the barcode, whatever the row carried; the photo stays unless the save
// changes the barcode.
func TestEverySaveStampsThePhoto(t *testing.T) {
	app := testutil.NewApp(t)
	Register(app)
	photo := testutil.SeedProductPhoto(t, app, "4000417025005")
	listID := testutil.CreateList(t, app, "Test")
	id := testutil.CreateItem(t, app, listID, "Milch", func(r *core.Record) {
		r.Set("barcode", "4000417025005")
		r.Set("image_url", "https://tracker.example/pixel.gif")
	}).Id
	for _, step := range []struct {
		when, want string
		edit       func(*core.Record)
	}{
		{"create", photo, nil},
		{"unscan", "", func(r *core.Record) { r.Set("barcode", "") }},
		{"another change", "kept", func(r *core.Record) { r.Set("image_url", "kept"); r.Set("quantity", "2") }},
	} {
		item, err := app.FindRecordById("items", id)
		if err != nil {
			t.Fatal(err)
		}
		if step.edit != nil {
			step.edit(item)
			if err := app.Save(item); err != nil {
				t.Fatal(err)
			}
		}
		if got := item.GetString("image_url"); got != step.want {
			t.Errorf("%s: image_url %q, want %q", step.when, got, step.want)
		}
	}
}
