package barcode

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/apis"

	"shoppinglist/internal/security"
)

// [D-218] With the scanner off only the photo route is mounted: the lookup —
// the one thing that calls Open Food Facts — is gone, while a photo stored
// before the switch still serves, because items carry its URL.
func TestScannerOffKeepsPhotosAndDropsTheLookup(t *testing.T) {
	newUpstream(t)
	app, full, token := barcodeMux(t)
	_, body := lookup(t, full, token, "4006381333931")
	if body.ImageURL == "" {
		t.Fatal("setup: expected a stored photo")
	}

	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	RegisterPhotoRoute(security.AppRoutes(r))
	security.ResetLimiters()
	off, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/barcode/4006381333931", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	off.ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Errorf("lookup with the scanner off: status = %d, want 404", res.Code)
	}

	res = httptest.NewRecorder()
	off.ServeHTTP(res, httptest.NewRequest(http.MethodGet, body.ImageURL, nil))
	if res.Code != http.StatusOK || res.Body.Len() == 0 {
		t.Errorf("stored photo with the scanner off: status = %d, %d bytes; want 200 with the image", res.Code, res.Body.Len())
	}
}

// ScannerEnv: unset is on, on/off are the two words, anything else fails.
func TestScannerFromEnv(t *testing.T) {
	for _, tc := range []struct {
		value   string
		want    bool
		wantErr bool
	}{
		{"", true, false},
		{"on", true, false},
		{"OFF", false, false},
		{"off", false, false},
		{"false", false, true},
		{"0", false, true},
	} {
		t.Setenv(ScannerEnv, tc.value)
		got, err := ScannerFromEnv()
		if (err != nil) != tc.wantErr || (!tc.wantErr && got != tc.want) {
			t.Errorf("%s=%q = %v, %v; want %v, error %v", ScannerEnv, tc.value, got, err, tc.want, tc.wantErr)
		}
	}
}
