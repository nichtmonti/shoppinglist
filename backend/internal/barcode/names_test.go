package barcode

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func lookupIn(t *testing.T, mux http.Handler, token, ean, lang string) (int, product) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/barcode/"+ean+"?lang="+lang, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	var body product
	_ = json.Unmarshal(res.Body.Bytes(), &body)
	return res.Code, body
}

// [D-21]: one upstream lookup stores every name, and each caller is answered
// in its own UI language — on the miss that fetched it and from the cache alike.
func TestLookupAnswersInTheCallersLanguage(t *testing.T) {
	up := newUpstream(t)
	up.name, up.nameDE, up.nameEN = "Pâte à tartiner", "Nuss-Nougat-Creme", "Hazelnut spread"
	_, mux, token := barcodeMux(t)

	for _, test := range []struct{ lang, want string }{
		{"de", "Nuss-Nougat-Creme"}, // the miss: fetched and stored
		{"de", "Nuss-Nougat-Creme"}, // from here on, the cache
		{"en", "Hazelnut spread"},
		{"", "Pâte à tartiner"},
		{"fr", "Pâte à tartiner"}, // no column for it: the main-language name
	} {
		if code, body := lookupIn(t, mux, token, "3017620422003", test.lang); code != http.StatusOK || body.Name != test.want {
			t.Errorf("lang=%q: status %d, name %q; want %q", test.lang, code, body.Name, test.want)
		}
	}
	// Whatever language the caller asked for, both localized names ride along
	// so the created item can carry them ([D-21]).
	if _, body := lookupIn(t, mux, token, "3017620422003", "de"); body.NameDE != "Nuss-Nougat-Creme" || body.NameEN != "Hazelnut spread" {
		t.Errorf("localized names = %q / %q, want both", body.NameDE, body.NameEN)
	}
	if hits := up.siteCounts()[offKey]; hits != 1 {
		t.Errorf("OFF was asked %d times, want once — the language must not split the cache", hits)
	}
}

// A language the upstream has no name in falls back to the main-language name
// rather than answering with an empty one.
func TestLookupFallsBackToTheMainName(t *testing.T) {
	up := newUpstream(t)
	up.name, up.nameEN = "Duftglas", "Scented jar"
	_, mux, token := barcodeMux(t)

	if _, body := lookupIn(t, mux, token, "4009078762076", "de"); body.Name != "Duftglas" {
		t.Errorf("name = %q, want the main-language name", body.Name)
	}
}

// A product entered only under a localized name has an empty product_name; it
// is still a named product, not a miss.
func TestEmptyMainNameUsesALocalizedOne(t *testing.T) {
	up := newUpstream(t)
	up.name, up.nameDE = "", "Spülmaschinenpfleger"
	_, mux, token := barcodeMux(t)

	code, body := lookupIn(t, mux, token, "4337256107433", "en")
	if code != http.StatusOK || body.Name != "Spülmaschinenpfleger" {
		t.Errorf("status %d, name %q; want the German name as the product's only name", code, body.Name)
	}
}

// Nothing named in any language is a miss, as before.
func TestNoNameAtAllIsAMiss(t *testing.T) {
	up := newUpstream(t)
	up.name = ""
	_, mux, token := barcodeMux(t)

	if code, _ := lookupIn(t, mux, token, "4337256107433", "de"); code != http.StatusNotFound {
		t.Errorf("status %d, want 404", code)
	}
}
