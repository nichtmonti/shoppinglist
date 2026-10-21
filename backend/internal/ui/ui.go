// Package ui serves the compiled SvelteKit shell and stamps into it, as
// <meta name> tags, the values an operator sets that only the client acts on:
// the per-list items cap (SHOPPINGLIST_MAX_ITEMS_PER_LIST, [D-217]), the
// scanner switch (SHOPPINGLIST_SCANNER, [D-218]), the source link
// (SHOPPINGLIST_SOURCE_URL, [D-211]) and the release the binary was built as.
//
// Meta tags rather than a config endpoint: no unauthenticated catch-all route,
// no boot round trip, and the values come with every boot the app can perform,
// offline included (§12). The service worker is network-first for
// navigations, so installed clients see a change on their next online boot.
//
// The stamp does not disturb the CSP: it touches neither the baked-in policy
// nor the inline script its hash covers, and security.loadCSP reads the
// embedded bytes, not the served ones.
package ui

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/envflag"
	"shoppinglist/internal/settings"
)

// The meta names and the default source link are a contract with
// frontend/src/lib/config.ts, which imports the same JSON.
//
//go:embed shell-meta.json
var shellMetaJSON []byte

var shellMeta = func() (m struct {
	// VersionMeta carries the release this binary was built as, for the
	// settings screen's about line ([D-181]).
	VersionMeta string `json:"version_meta"`
	// SourceMeta carries the source link; DefaultSourceURL is it when
	// SourceURLEnv is unset.
	SourceMeta string `json:"source_meta"`
	// MaxItemsPerListMeta carries the [D-217] per-list items cap when the
	// operator moved it, so the import dialog refuses a file the server would
	// refuse.
	MaxItemsPerListMeta string `json:"max_items_per_list_meta"`
	// ScannerMeta says the operator switched the barcode scanner off
	// ([D-218]): "off" then, absent otherwise, so a shell served without it
	// (Vite, an old precached one) keeps the scan button.
	ScannerMeta      string `json:"scanner_meta"`
	DefaultSourceURL string `json:"default_source_url"`
}) {
	if err := json.Unmarshal(shellMetaJSON, &m); err != nil {
		// Embedded at build time: a parse failure is a broken build.
		panic(fmt.Sprintf("ui: cannot parse shell-meta.json: %v", err))
	}
	if m.VersionMeta == "" || m.SourceMeta == "" || m.MaxItemsPerListMeta == "" ||
		m.ScannerMeta == "" || m.DefaultSourceURL == "" {
		panic("ui: shell-meta.json is missing a value")
	}
	return m
}()

// SourceURLEnv sets the source link the settings screen offers every user,
// which the AGPL-3.0 requires to point at a modified instance's own source
// ([D-211]). Unset, it is shell-meta.json's default_source_url, this
// project's.
const SourceURLEnv = settings.SourceURLEnv

// Shell is everything stamped into the shell document. A nil/empty field means
// "the operator set nothing", and the client uses its compiled default.
type Shell struct {
	// Version is the link-time release, filled by main.
	Version string
	// SourceURL is where this instance's source code is ([D-211]).
	SourceURL string
	// MaxItemsPerList is the [D-217] cap, nil when it is the default.
	MaxItemsPerList *int
	// ScannerOff hides the scan button; main fills it.
	ScannerOff bool
}

// Empty reports whether there is nothing to stamp, in which case Index returns
// nil and Static serves the embedded shell untouched.
func (s Shell) Empty() bool {
	return s.Version == "" && s.SourceURL == "" &&
		s.MaxItemsPerList == nil && !s.ScannerOff
}

// metas renders each configured field as a <meta name> tag.
func (s Shell) metas() []string {
	var out []string
	if s.Version != "" {
		out = append(out, meta(shellMeta.VersionMeta, s.Version))
	}
	if s.SourceURL != "" {
		out = append(out, meta(shellMeta.SourceMeta, s.SourceURL))
	}
	if s.MaxItemsPerList != nil {
		out = append(out, meta(shellMeta.MaxItemsPerListMeta, strconv.Itoa(*s.MaxItemsPerList)))
	}
	if s.ScannerOff {
		out = append(out, meta(shellMeta.ScannerMeta, "off"))
	}
	return out
}

// meta is one <meta name> tag, its attribute values HTML-escaped: Go's %q
// quoting leaves < > & as they are.
func meta(name, content string) string {
	return `<meta name="` + html.EscapeString(name) + `" content="` + html.EscapeString(content) + `" />`
}

// ShellFromSettings takes SHOPPINGLIST_SOURCE_URL, the one shell setting this
// package owns; a value that is not an absolute http(s) URL fails the boot
// ([D-61]).
func ShellFromSettings(s settings.Serve) (Shell, error) {
	source := s.SourceURL
	if source == "" {
		source = shellMeta.DefaultSourceURL
	} else if err := envflag.AbsoluteURL(source); err != nil {
		return Shell{}, fmt.Errorf("%s: %w", SourceURLEnv, err)
	}
	return Shell{SourceURL: source}, nil
}

var headPattern = regexp.MustCompile(`(?i)<head[^>]*>`)

// Index returns the shell document to serve: the embedded index.html with one
// meta tag stamped into its <head> per configured field of `shell`.
//
// It returns nil (serve the embedded file untouched) when nothing is
// configured or there is no index.html (the no_ui build). An index.html
// without a <head> is a broken build, and the binary refuses to start rather
// than serve a shell that silently lacks the settings (the source link, the
// scanner switch, the caps).
func Index(publicFS fs.FS, shell Shell) []byte {
	if publicFS == nil || shell.Empty() {
		return nil
	}
	html, err := fs.ReadFile(publicFS, router.IndexPage)
	if err != nil {
		return nil
	}
	loc := headPattern.FindIndex(html)
	if loc == nil {
		panic("the embedded index.html has no <head> to stamp the settings into: the SPA build is broken")
	}
	tags := "\n\t\t" + strings.Join(shell.metas(), "\n\t\t")
	out := make([]byte, 0, len(html)+len(tags))
	out = append(out, html[:loc[1]]...)
	out = append(out, tags...)
	out = append(out, html[loc[1]:]...)
	return out
}

// Static serves the SPA as apis.Static(publicFS, true) does, except that
// where that would serve the root index.html ("/" and the SPA fallback) it
// serves the stamped index; a nil index serves the embedded one. The embedded
// files have no modtime, so no validator: the shell is fetched on every load
// (no-cache), and SvelteKit's content-hashed _app/immutable/ files are kept
// for a year.
func Static(publicFS fs.FS, index []byte) func(*core.RequestEvent) error {
	stock := apis.Static(publicFS, true)
	return func(e *core.RequestEvent) error {
		name := path.Clean(strings.TrimPrefix(e.Request.PathValue(apis.StaticWildcardParam), "/"))
		if !servesIndex(publicFS, name) {
			if strings.HasPrefix(name, "_app/immutable/") {
				e.Response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			return stock(e)
		}
		e.Response.Header().Set("Cache-Control", "no-cache")
		if index == nil {
			return stock(e)
		}
		// The zero modtime matches the embedded FS: no Last-Modified, no ETag,
		// so the rewritten body cannot produce a stale 304.
		http.ServeContent(e.Response, e.Request, router.IndexPage, time.Time{}, bytes.NewReader(index))
		return nil
	}
}

// servesIndex reports whether the stock handler would answer a request for
// the cleaned path name with the root index.html, mirroring apis.Static: name
// is the index page or names nothing in the FS. Real entries, directories
// included, stay with the stock handler and its canonical redirects.
func servesIndex(publicFS fs.FS, name string) bool {
	if name == "." || name == router.IndexPage {
		return true
	}
	_, err := fs.Stat(publicFS, name)
	return err != nil
}
