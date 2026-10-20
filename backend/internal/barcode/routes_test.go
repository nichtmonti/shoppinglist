package barcode

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

func barcodeTestAccount(t *testing.T, app core.App) string {
	t.Helper()
	c, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(c)
	rec.Set("handle", "barcode-test-handle")
	rec.Set("nickname", "barcode tester")
	rec.SetRandomPassword()
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
	token, err := rec.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func barcodeMux(t *testing.T) (core.App, http.Handler, string) {
	t.Helper()
	app := testutil.NewApp(t)
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	// The app's headers too, so a photo's own policy is seen through them.
	security.Register(r, nil, true)
	RegisterRoutes(security.AppRoutes(r))
	// Every test here builds its own router rather than testutil.NewMux, so it
	// re-arms the per-IP budgets itself — otherwise the whole package shares
	// one 30-per-minute lookup bucket, and whichever test runs 31st gets a 429.
	security.ResetLimiters()
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	return app, mux, barcodeTestAccount(t, app)
}

func TestLookupRequiresAuthAndValidEAN(t *testing.T) {
	_, mux, token := barcodeMux(t)
	for _, test := range []struct {
		name string
		path string
		want int
	}{
		{name: "anonymous", path: "/api/barcode/4005808307870", want: http.StatusUnauthorized},
		{name: "invalid", path: "/api/barcode/not-a-barcode", want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			if test.name != "anonymous" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			res := httptest.NewRecorder()
			mux.ServeHTTP(res, req)
			if res.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", res.Code, test.want, res.Body.String())
			}
		})
	}
}

func TestLookupUsesFreshPositiveAndNegativeCache(t *testing.T) {
	app, mux, token := barcodeMux(t)
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		t.Fatal(err)
	}
	positive := core.NewRecord(c)
	positive.Set("barcode", "4005808307870")
	positive.Set("name", "Nivea Sun")
	positive.Set("image_url", "https://images.openbeautyfacts.org/image.jpg")
	positive.Set("category_slug", "personal_care")
	positive.Set("found", true)
	positive.Set("fetched_at", time.Now())
	if err := app.SaveNoValidate(positive); err != nil {
		t.Fatal(err)
	}

	negative := core.NewRecord(c)
	negative.Set("barcode", "0000000000000")
	negative.Set("found", false)
	negative.Set("fetched_at", time.Now())
	if err := app.SaveNoValidate(negative); err != nil {
		t.Fatal(err)
	}

	request := func(code string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/barcode/"+code, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}
	res := request("4005808307870")
	if res.Code != http.StatusOK {
		t.Fatalf("positive cache status = %d: %s", res.Code, res.Body.String())
	}
	var body product
	if err := json.NewDecoder(strings.NewReader(res.Body.String())).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "Nivea Sun" || body.CategorySlug != "personal_care" {
		t.Fatalf("cached body = %+v", body)
	}
	if res = request("0000000000000"); res.Code != http.StatusNotFound {
		t.Fatalf("negative cache status = %d: %s", res.Code, res.Body.String())
	}
}

// TestNegativeCacheTTL: a barcode miss is cached with the short TTL (5 minutes).
// Within that window, a re-lookup returns the cached 404 without re-fetching.
func TestNegativeCacheTTL(t *testing.T) {
	app, mux, token := barcodeMux(t)
	c, err := app.FindCollectionByNameOrId("barcode_cache")
	if err != nil {
		t.Fatal(err)
	}

	// Manually create a miss entry that is fresh (within negativeCacheTTL)
	negative := core.NewRecord(c)
	negative.Set("barcode", "9999999999999")
	negative.Set("found", false)
	negative.Set("fetched_at", time.Now())
	if err := app.SaveNoValidate(negative); err != nil {
		t.Fatal(err)
	}

	// Request that barcode — should hit cache and return 404 without re-fetching
	req := httptest.NewRequest(http.MethodGet, "/api/barcode/9999999999999", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("negative cache status = %d: %s", res.Code, res.Body.String())
	}

	// Verify the cache record was NOT updated (no re-fetch occurred)
	cached, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": "9999999999999"})
	if err != nil {
		t.Fatal(err)
	}
	if !cached.GetBool("found") {
		// Still a miss — we didn't re-fetch
		if cached.GetString("name") != "" || cached.GetString("image_url") != "" || cached.GetString("category_slug") != "" {
			t.Errorf("negative cache was overwritten with data: name=%q image_url=%q category_slug=%q",
				cached.GetString("name"), cached.GetString("image_url"), cached.GetString("category_slug"))
		}
	} else {
		t.Errorf("negative cache flipped to found=true (re-fetch occurred)")
	}
}
