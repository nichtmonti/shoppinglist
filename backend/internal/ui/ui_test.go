package ui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"

	"shoppinglist/internal/settings"
	_ "shoppinglist/migrations" // register collection migrations for RunAllMigrations
)

// ShellFromEnv reads the settings as the start does, for the tests that set them.
func ShellFromEnv() (Shell, error) {
	s, err := settings.ReadServe()
	if err != nil {
		return Shell{}, err
	}
	return ShellFromSettings(s)
}

// A stand-in for the SvelteKit build: the CSP meta tag whose exact bytes
// internal/security mirrors as a header, plus the inline bootstrap script that
// tag's sha256 covers. Both are here so the injection tests can prove neither
// is disturbed.
const shell = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta http-equiv="content-security-policy" content="script-src 'sha256-abc'">
	</head>
	<body><script>bootstrap()</script></body>
</html>`

func buildFS() fs.FS {
	return fstest.MapFS{
		"index.html":  &fstest.MapFile{Data: []byte(shell)},
		"favicon.svg": &fstest.MapFile{Data: []byte("<svg/>")},
		"_app/app.js": &fstest.MapFile{Data: []byte("console.log(1)")},

		"_app/immutable/entry/app.Bx3k.js": &fstest.MapFile{Data: []byte("console.log(2)")},
	}
}

func TestIndexStampsTheSourceLink(t *testing.T) {
	out := Index(buildFS(), Shell{SourceURL: "https://git.example.org/me/shoppinglist"})
	if out == nil {
		t.Fatal("Index returned nil for a valid shell")
	}
	got := string(out)

	want := `<meta name="` + shellMeta.SourceMeta + `" content="https://git.example.org/me/shoppinglist" />`
	if !strings.Contains(got, want) {
		t.Errorf("stamped shell is missing %s:\n%s", want, got)
	}
	// Inside <head>, so the document parses it before the SPA boots.
	if strings.Index(got, want) > strings.Index(got, "</head>") {
		t.Error("the meta tag was injected outside <head>")
	}
	// The CSP meta and the script its hash covers must survive byte-identical:
	// internal/security mirrors that policy string as a header from the
	// EMBEDDED copy, and the two are asserted equal by e2e/tests/csp.spec.ts.
	if !strings.Contains(got, `<meta http-equiv="content-security-policy" content="script-src 'sha256-abc'">`) {
		t.Error("the CSP meta tag was disturbed")
	}
	if !strings.Contains(got, "<script>bootstrap()</script>") {
		t.Error("the hashed inline bootstrap script was disturbed")
	}
}

// [D-181] The release is stamped for the settings screen's about line — on
// its own, with no operator setting, since every built binary has one.
func TestIndexStampsTheVersion(t *testing.T) {
	shell := Shell{Version: "v0.5.0 (abc1234)"}
	if shell.Empty() {
		t.Fatal("a shell carrying only a version reported itself empty")
	}
	out := Index(buildFS(), shell)
	if out == nil {
		t.Fatal("Index returned nil for a shell with a version")
	}
	want := `<meta name="` + shellMeta.VersionMeta + `" content="v0.5.0 (abc1234)" />`
	if got := string(out); !strings.Contains(got, want) || strings.Index(got, want) > strings.Index(got, "</head>") {
		t.Errorf("stamped shell is missing %s inside <head>:\n%s", want, got)
	}
}

// Every "nothing to do or something is off" case serves the embedded file
// untouched: a shell missing a setting is a nuisance, a corrupted one does
// not render at all.
func TestIndexDeclinesRatherThanCorrupts(t *testing.T) {
	de := Shell{SourceURL: "https://git.example.org/me/shoppinglist"}
	for _, tc := range []struct {
		name  string
		fsys  fs.FS
		shell Shell
	}{
		{name: "nothing configured", fsys: buildFS(), shell: Shell{}},
		{name: "nil FS (a no_ui build)", fsys: nil, shell: de},
		{name: "FS without an index.html", fsys: fstest.MapFS{}, shell: de},
		{name: "markup with no head", shell: de,
			fsys: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html><body>hi</body></html>")}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if out := Index(tc.fsys, tc.shell); out != nil {
				t.Errorf("Index = %q, want nil (serve the embedded file untouched)", out)
			}
		})
	}
}

// Each field is stamped on its own: an operator who sets only the cap gets
// only that tag, and the client falls back to its own compiled
// default for everything left unstamped.
func TestIndexStampsEachKnobIndependently(t *testing.T) {
	itemsCap := 300
	for _, tc := range []struct {
		name   string
		shell  Shell
		want   []string
		absent []string
	}{
		{
			name:   "source link only",
			shell:  Shell{SourceURL: "https://git.example.org/me/shoppinglist"},
			want:   []string{`<meta name="` + shellMeta.SourceMeta + `" content="https://git.example.org/me/shoppinglist" />`},
			absent: []string{shellMeta.MaxItemsPerListMeta, shellMeta.ScannerMeta},
		},
		{
			name:   "items cap only ([D-217])",
			shell:  Shell{MaxItemsPerList: &itemsCap},
			want:   []string{`<meta name="` + shellMeta.MaxItemsPerListMeta + `" content="300" />`},
			absent: []string{shellMeta.SourceMeta, shellMeta.ScannerMeta},
		},
		{
			name:   "scanner off ([D-218])",
			shell:  Shell{ScannerOff: true},
			want:   []string{`<meta name="` + shellMeta.ScannerMeta + `" content="off" />`},
			absent: []string{shellMeta.SourceMeta, shellMeta.MaxItemsPerListMeta},
		},
		{
			name:   "a scanner left on is not stamped",
			shell:  Shell{SourceURL: "https://git.example.org/me/shoppinglist"},
			absent: []string{shellMeta.ScannerMeta},
		},
		{
			name:   "an unset items cap is not stamped",
			shell:  Shell{SourceURL: "https://git.example.org/me/shoppinglist"},
			absent: []string{shellMeta.MaxItemsPerListMeta},
		},
		{
			name:  "all together",
			shell: Shell{SourceURL: "https://git.example.org/me/shoppinglist", MaxItemsPerList: &itemsCap, ScannerOff: true},
			want: []string{
				`<meta name="` + shellMeta.SourceMeta + `" content="https://git.example.org/me/shoppinglist" />`,
				`<meta name="` + shellMeta.MaxItemsPerListMeta + `" content="300" />`,
				`<meta name="` + shellMeta.ScannerMeta + `" content="off" />`,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := Index(buildFS(), tc.shell)
			if out == nil {
				t.Fatal("Index returned nil for a configured shell")
			}
			got := string(out)
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("stamped shell is missing %s:\n%s", want, got)
				}
				// Inside <head>: the document must have parsed every one of
				// these before the SPA's module scripts run.
				if strings.Index(got, want) > strings.Index(got, "</head>") {
					t.Errorf("%s was injected outside <head>", want)
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(got, absent) {
					t.Errorf("stamped an unset knob (%s):\n%s", absent, got)
				}
			}
			// The hashed inline bootstrap and the CSP meta survive three tags
			// as they do one — see TestIndexStampsTheSourceLink.
			if !strings.Contains(got, "<script>bootstrap()</script>") {
				t.Error("the hashed inline bootstrap script was disturbed")
			}
			if !strings.Contains(got, `<meta http-equiv="content-security-policy" content="script-src 'sha256-abc'">`) {
				t.Error("the CSP meta tag was disturbed")
			}
		})
	}
}

func serve(t *testing.T, publicFS fs.FS, index []byte) http.Handler {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	r.GET("/{path...}", Static(publicFS, index))
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return mux
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// Both entry points must carry the stamp: "/" itself, and the SPA fallback
// every deep link takes — a shared invite link lands on /join, not /.
func TestStaticStampsBothEntryPoints(t *testing.T) {
	h := serve(t, buildFS(), Index(buildFS(), Shell{SourceURL: "https://git.example.org/me/shoppinglist"}))

	for _, path := range []string{"/", "/index.html", "/join", "/list/abc123", "/settings"} {
		t.Run(path, func(t *testing.T) {
			rec := get(t, h, path)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200", path, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), `name="`+shellMeta.SourceMeta+`"`) {
				t.Errorf("GET %s served an unstamped shell:\n%s", path, rec.Body.String())
			}
			if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
				t.Errorf("GET %s Content-Type = %q, want text/html", path, ct)
			}
		})
	}
}

// A real asset must still come off the embedded FS — stamping the shell must
// not turn every 404 into HTML or shadow the build output.
func TestStaticLeavesRealFilesAlone(t *testing.T) {
	h := serve(t, buildFS(), Index(buildFS(), Shell{SourceURL: "https://git.example.org/me/shoppinglist"}))

	rec := get(t, h, "/_app/app.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /_app/app.js = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "console.log(1)" {
		t.Errorf("asset body = %q, want the embedded file", got)
	}
	if strings.Contains(rec.Body.String(), shellMeta.SourceMeta) {
		t.Error("an asset response was stamped")
	}
}

// The files carry no validator, so the headers decide: the shell is fetched
// on every load, so a new release reaches the next one, and only SvelteKit's
// content-hashed files are kept, never the shell answering for a chunk that
// is gone.
func TestStaticCacheHeaders(t *testing.T) {
	for _, index := range [][]byte{nil, Index(buildFS(), Shell{Version: "v1"})} {
		h := serve(t, buildFS(), index)
		for path, want := range map[string]string{
			"/":                                 "no-cache",
			"/list/abc123":                      "no-cache",
			"/_app/immutable/entry/gone.Zz9.js": "no-cache",
			"/_app/immutable/entry/app.Bx3k.js": "public, max-age=31536000, immutable",
			"/_app/app.js":                      "",
			"/favicon.svg":                      "",
		} {
			if got := get(t, h, path).Header().Get("Cache-Control"); got != want {
				t.Errorf("stamped=%v GET %s Cache-Control = %q, want %q", index != nil, path, got, want)
			}
		}
	}
}

// nil index is the unset-env and no_ui path: byte-for-byte stock apis.Static.
func TestStaticWithoutAStampIsStock(t *testing.T) {
	h := serve(t, buildFS(), nil)

	rec := get(t, h, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != shell {
		t.Errorf("GET / = %q, want the embedded shell verbatim", got)
	}
}

// [D-211]: every shell carries a source link — this project's when unset, the
// operator's own otherwise — and a value that is not an absolute URL refuses
// the boot rather than shipping a dead link.
func TestShellFromEnvSourceURL(t *testing.T) {
	for _, tc := range []struct {
		name, env, want string
		wantErr         bool
	}{
		{name: "unset is this project's repository", env: "", want: shellMeta.DefaultSourceURL},
		{name: "whitespace is unset", env: "  ", want: shellMeta.DefaultSourceURL},
		{name: "an operator's fork", env: "https://git.example.org/me/shoppinglist", want: "https://git.example.org/me/shoppinglist"},
		{name: "not an absolute URL", env: "git.example.org/me", wantErr: true},
		{name: "a script URL", env: "javascript://example.org/%0aalert(1)", wantErr: true},
		{name: "another scheme", env: "ftp://git.example.org/me", wantErr: true},
		{name: "plain http", env: "http://git.example.org/me", want: "http://git.example.org/me"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(SourceURLEnv, tc.env)
			got, err := ShellFromEnv()
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), SourceURLEnv) {
					t.Fatalf("ShellFromEnv() error = %v, want one naming %s", err, SourceURLEnv)
				}
				return
			}
			if err != nil {
				t.Fatalf("ShellFromEnv(): %v", err)
			}
			if got.SourceURL != tc.want {
				t.Errorf("SourceURL = %q, want %q", got.SourceURL, tc.want)
			}
			if !strings.Contains(strings.Join(got.metas(), "\n"), `name="`+shellMeta.SourceMeta+`" content="`+tc.want+`"`) {
				t.Errorf("metas %q do not stamp the source link", got.metas())
			}
		})
	}
}

// A stamped value is HTML-escaped inside its attribute, so a quote or an angle
// bracket in it cannot end the tag.
func TestMetasEscapeTheirValues(t *testing.T) {
	got := strings.Join(Shell{
		Version:   `v1 "><script>x()</script>`,
		SourceURL: "https://git.example.org/me?a=1&b='2'",
	}.metas(), "\n")
	for _, want := range []string{
		`content="v1 &#34;&gt;&lt;script&gt;x()&lt;/script&gt;"`,
		`content="https://git.example.org/me?a=1&amp;b=&#39;2&#39;"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("metas = %s\nwant %s", got, want)
		}
	}
	if strings.Contains(got, "<script>") {
		t.Errorf("a value broke out of its attribute: %s", got)
	}
}
