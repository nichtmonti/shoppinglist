package barcode

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"

	"shoppinglist/internal/records"
)

// photoTokenPattern matches what randid.ID emits, so a lookup by token never
// reaches the database with anything else.
var photoTokenPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// photoHosts is fetchPhoto's host allowlist.
var photoHosts = []string{
	"images.openfoodfacts.org",
	"images.openbeautyfacts.org",
	"images.openpetfoodfacts.org",
	"images.openproductsfacts.org",
}

const (
	// maxPhotoBytes caps a stored product photo; real ones run 19-37 KiB.
	maxPhotoBytes = 512 << 10

	// photoPathPrefix is the public route product photos are served under.
	// It is baked into synced items.image_url values, so changing it strands
	// existing photos.
	photoPathPrefix = "/api/barcode/photo/"
)

// photoContentTypes maps a sniffed content type to the extension stored with
// the file; anything else is refused.
var photoContentTypes = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
}

// photoDownload is one photo download's outcome: the bytes and their extension,
// or none, and then whether another try could succeed.
type photoDownload struct {
	data  []byte
	ext   string
	retry bool
}

// fetchPhoto downloads a product photo for local storage. A failure that can
// pass (no connection, a timeout, a 5xx, 408 or 429) says retry; one that
// would come out the same next time (any other 4xx, a redirect, a body that is
// no image or too big, a URL the allowlist refuses) does not ([D-21]).
//
// It is the app's only outbound request whose URL comes from a response body,
// so it guards against SSRF: the URL comes from upstream JSON, never from a
// client (items.image_url is never read here); the host must be in
// photoHosts; upstreamClient refuses redirects, so that check cannot be
// walked around; and it runs only for a product a lookup found.
func fetchPhoto(rawURL string) photoDownload {
	if rawURL == "" {
		return photoDownload{}
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || !allowedPhotoHost(u.Host) {
		return photoDownload{}
	}
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return photoDownload{}
	}
	req.Header.Set("User-Agent", userAgent)
	// upstreamClient's redirect policy and transport, with the photo's own
	// limit: the download goes on after the lookup has answered.
	client := *upstreamClient
	client.Timeout = photoTimeout
	resp, err := client.Do(req)
	if err != nil {
		return photoDownload{retry: true}
	}
	defer resp.Body.Close()
	switch code := resp.StatusCode; {
	case code >= 500, code == http.StatusRequestTimeout, code == http.StatusTooManyRequests:
		return photoDownload{retry: true}
	case code < 200 || code >= 300:
		return photoDownload{}
	}
	// One byte past the cap detects an oversized file without buffering it.
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxPhotoBytes+1))
	if err != nil {
		return photoDownload{retry: true}
	}
	if len(data) == 0 || len(data) > maxPhotoBytes {
		return photoDownload{}
	}
	// Sniff the bytes rather than trust Content-Type: the magic number is what
	// a browser acts on.
	ext, ok := photoContentTypes[http.DetectContentType(data)]
	if !ok {
		return photoDownload{}
	}
	return photoDownload{data: data, ext: ext}
}

func allowedPhotoHost(host string) bool {
	return slices.Contains(photoHosts, host)
}

// photoHandler serves a cached product photo to anyone holding its token,
// unauthenticated because an <img src> cannot carry a bearer token.
func photoHandler(e *core.RequestEvent) error {
	token := e.Request.PathValue("token")
	if !photoTokenPattern.MatchString(token) {
		return e.NotFoundError("not found", nil)
	}
	rec, err := records.FindFirstOptional(e.App, "barcode_cache", dbx.HashExp{"photo_token": token})
	if err != nil {
		return e.InternalServerError("failed to read barcode cache", err)
	}
	if rec == nil || rec.GetString("photo") == "" {
		return e.NotFoundError("not found", nil)
	}
	name := rec.GetString("photo")
	fsys, err := e.App.NewFilesystem()
	if err != nil {
		return e.InternalServerError("storage unavailable", err)
	}
	defer fsys.Close()

	// The token rotates whenever the bytes change (fillAndSaveCache). Serve
	// sets only headers still missing, so this one goes first and is taken
	// back on a failure, which must not be cached for a year.
	e.Response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	// Serve's own sandboxed policy, not the app's, for a file.
	e.Response.Header().Del("Content-Security-Policy")
	if err := fsys.Serve(e.Response, e.Request, rec.BaseFilesPath()+"/"+name, name); err != nil {
		e.Response.Header().Del("Cache-Control")
		if errors.Is(err, filesystem.ErrNotFound) {
			return e.NotFoundError("not found", nil)
		}
		return e.InternalServerError("storage unavailable", err)
	}
	return nil
}
