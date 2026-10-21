package barcode

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// upstreamClient does not follow redirects, against SSRF via an upstream
// redirect.
var upstreamClient = &http.Client{
	Timeout: 5 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// userAgent names the app to the Open Food Facts sites, which ask every API
// client to say who it is. SetUserAgent fills in the release and source.
var userAgent = "shoppinglist"

// SetUserAgent sets the User-Agent of every upstream request to
// "shoppinglist/<version> (+<sourceURL>)". It is called once at boot, before
// the first request.
func SetUserAgent(version, sourceURL string) {
	userAgent = fmt.Sprintf("shoppinglist/%s (+%s)", version, sourceURL)
}

// upstreamGet is upstreamClient.Get with the User-Agent set.
func upstreamGet(rawURL string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	return upstreamClient.Do(req)
}

// upstreamSite is one Open Food Facts database. Category, when set, replaces
// the tag mapping, whose rules misread such a site's tags ("en:body-milks"
// reads as dairy).
type upstreamSite struct {
	URL      string
	Category string
}

// Upstream bases are variables so tests can point them at an httptest server.
//
// OFF is the index ([D-21]): for a barcode held by a sister site it answers
// 404 naming that site's product_type, which only selects a key here, so no
// URL is taken from a response body.
var (
	offSite      = upstreamSite{URL: "https://world.openfoodfacts.org/api/v3/product/%s"}
	siblingSites = map[string]upstreamSite{
		"beauty":  {URL: "https://world.openbeautyfacts.org/api/v3/product/%s", Category: "personal_care"},
		"petfood": {URL: "https://world.openpetfoodfacts.org/api/v3/product/%s", Category: "pet"},
		"product": {URL: "https://world.openproductsfacts.org/api/v3/product/%s"},
	}
)

// upstreamFields trims each answer to what fetchProduct reads.
const upstreamFields = "?fields=product_name,product_name_de,product_name_en,image_url,image_front_url,categories_tags"

// maxUpstreamBytes caps upstream response decoding against a hostile or
// broken upstream.
const maxUpstreamBytes = 1 << 20

// fetchedProduct is one upstream lookup's result on its way into the cache,
// with the photo bytes stored as a file.
type fetchedProduct struct {
	// Name is the main-language name, else the first localized one. NameDE and
	// NameEN may be empty ([D-21]).
	Name   string
	NameDE string
	NameEN string
	// UpstreamImageURL is kept for provenance and refetching only, never
	// handed to a browser.
	UpstreamImageURL string
	CategorySlug     string
	// PhotoBytes is set only for a product stored without a lookup (Store);
	// a lookup's photo arrives through downloadPhoto.
	PhotoBytes []byte
	PhotoExt   string
}

// upstreamResponse is the v3 product API's answer. A miss is a 404 whose
// result.id says why: "product_not_found", or
// "product_found_with_a_different_product_type" with the owning site's type in
// the product_type error field.
type upstreamResponse struct {
	Result struct {
		ID string `json:"id"`
	} `json:"result"`
	Errors []struct {
		Field struct {
			ID    string `json:"id"`
			Value string `json:"value"`
		} `json:"field"`
	} `json:"errors"`
	Product *struct {
		Name       string   `json:"product_name"`
		NameDE     string   `json:"product_name_de"`
		NameEN     string   `json:"product_name_en"`
		ImageURL   string   `json:"image_url"`
		ImageFront string   `json:"image_front_url"`
		Categories []string `json:"categories_tags"`
	} `json:"product"`
}

// errUpstreamUnavailable means no upstream gave a usable answer. It is
// distinct from `(nil, nil)`, "the barcode is unknown", which is cached; the
// caller must not touch the cache on this error, or an outage would
// negative-cache real products.
var errUpstreamUnavailable = errors.New("barcode upstreams unavailable")

// fetchProduct asks OFF, and at most one sister site when OFF names it
// ([D-21]).
func fetchProduct(ean string) (*fetchedProduct, error) {
	site := offSite
	body, err := queryUpstream(site, ean)
	if err != nil {
		return nil, err
	}
	if body.Product == nil && body.Result.ID == "product_found_with_a_different_product_type" {
		sibling, ok := siblingSites[body.productType()]
		if !ok {
			// A type we have no site for is still an answer: not found.
			return nil, nil
		}
		site = sibling
		if body, err = queryUpstream(site, ean); err != nil {
			return nil, err
		}
	}
	if body.Product == nil {
		return nil, nil
	}
	nameDE := strings.TrimSpace(body.Product.NameDE)
	nameEN := strings.TrimSpace(body.Product.NameEN)
	// A product with only localized names is still named, not a miss.
	name := cmp.Or(strings.TrimSpace(body.Product.Name), nameDE, nameEN)
	if name == "" {
		return nil, nil
	}
	imageURL := cmp.Or(body.Product.ImageURL, body.Product.ImageFront)
	out := &fetchedProduct{
		Name:             name,
		NameDE:           nameDE,
		NameEN:           nameEN,
		UpstreamImageURL: imageURL,
		CategorySlug:     cmp.Or(site.Category, mapCategory(body.Product.Categories)),
	}
	// The photo is downloaded apart from the lookup (download.go): a photo
	// failure is never a lookup failure (§9.1: a tile without a photo shows
	// the name).
	return out, nil
}

// queryUpstream makes one product request. It returns errUpstreamUnavailable,
// wrapped with the cause for the server log, unless the site answered: a 404,
// or a 2xx whose body decodes.
func queryUpstream(site upstreamSite, ean string) (*upstreamResponse, error) {
	product := fmt.Sprintf(site.URL, ean)
	resp, err := upstreamGet(product + upstreamFields)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errUpstreamUnavailable, err)
	}
	// Fully consumed by the decoder (or failed mid-read); the Close error is noise.
	defer func() { _ = resp.Body.Close() }()
	var body upstreamResponse
	switch {
	case resp.StatusCode == http.StatusNotFound:
		// A 404 is an answer whatever its body; the body only says which miss.
		if json.NewDecoder(io.LimitReader(resp.Body, maxUpstreamBytes)).Decode(&body) != nil {
			return &upstreamResponse{}, nil
		}
		body.Product = nil
		return &body, nil
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, fmt.Errorf("%w: %s answered %s", errUpstreamUnavailable, product, resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxUpstreamBytes)).Decode(&body); err != nil {
		return nil, fmt.Errorf("%w: %s sent an unreadable body: %w", errUpstreamUnavailable, product, err)
	}
	return &body, nil
}

// productType is the sister site's type from a "different product type" miss.
func (r *upstreamResponse) productType() string {
	for _, e := range r.Errors {
		if e.Field.ID == "product_type" {
			return e.Field.Value
		}
	}
	return ""
}
