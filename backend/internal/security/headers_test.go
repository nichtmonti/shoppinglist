package security

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil/testapp"
)

func setupApp(t *testing.T, publicFS fs.FS) http.Handler {
	t.Helper()
	return setupAppCamera(t, publicFS, true)
}

// setupAppCamera is setupApp with the scanner's camera allowance chosen
// ([D-218]).
func setupAppCamera(t *testing.T, publicFS fs.FS, camera bool) http.Handler {
	t.Helper()
	app := testapp.New(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	Register(router, publicFS, camera)
	// An arbitrary route stands in for "every response" — the middleware is
	// bound on the router itself, not any specific route.
	router.GET("/probe", func(e *core.RequestEvent) error {
		return e.String(http.StatusOK, "ok")
	})
	// Stands in for PocketBase's own dashboard mount, which this test's router
	// does not include.
	router.GET("/_/{path...}", func(e *core.RequestEvent) error {
		return e.String(http.StatusOK, "dashboard")
	})
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return mux
}

// indexFS stands in for the embedded pb_public: an filesystem holding an
// index.html with the meta tag SvelteKit's build emits. The SPA ([D-64])
// reaches security.Register as an fs.FS rather than a directory path, so the
// fixture is an in-memory FS rather than a temp dir.
func indexFS(body string) fs.FS {
	return fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(body)}}
}

func TestRegister_SetsSecurityHeadersOnEveryResponse(t *testing.T) {
	mux := setupApp(t, nil)

	want := map[string]string{
		"Referrer-Policy":            "no-referrer",
		"X-Content-Type-Options":     "nosniff",
		"Cross-Origin-Opener-Policy": "same-origin",
	}

	for _, url := range []string{"/probe", "/api/collections/category_templates/records", "/_/"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, url, nil)
		mux.ServeHTTP(rec, req)

		for header, expected := range want {
			if got := rec.Header().Get(header); got != expected {
				t.Errorf("%s: %s = %q, want %q", url, header, got, expected)
			}
		}
		if got := rec.Header().Get("Permissions-Policy"); got != permissionsPolicy {
			t.Errorf("%s: Permissions-Policy = %q, want %q", url, got, permissionsPolicy)
		}
		// COEP would block the Open Food Facts product images.
		if got := rec.Header().Get("Cross-Origin-Embedder-Policy"); got != "" {
			t.Errorf("%s: Cross-Origin-Embedder-Policy = %q, want unset", url, got)
		}
		// HSTS belongs to the TLS proxy; this process serves plain HTTP.
		if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
			t.Errorf("%s: Strict-Transport-Security = %q, want unset", url, got)
		}
	}
}

// No build present (dev, tests, an unbuilt tree): fall back to the frame
// policy alone rather than to something that would break the app.
func TestRegister_CSPFallsBackWithoutBuild(t *testing.T) {
	cases := map[string]fs.FS{
		// The no_ui build's empty embed.FS, and the nil an unwired caller would
		// pass — both must degrade to the baseline rather than panic.
		"nil FS":   nil,
		"empty FS": fstest.MapFS{},
	}

	for name, fsys := range cases {
		t.Run(name, func(t *testing.T) {
			mux := setupApp(t, fsys)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probe", nil))

			if got := rec.Header().Get("Content-Security-Policy"); got != baselineCSP {
				t.Errorf("Content-Security-Policy = %q, want %q", got, baselineCSP)
			}
		})
	}
}

// The policy on the wire is SvelteKit's, verbatim, plus the frame-ancestors a
// meta tag cannot express. Anything else means the header and the meta tag
// disagree, and a browser enforces both.
func TestRegister_CSPMirrorsIndexMetaTag(t *testing.T) {
	const policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-AbC123+/='; " +
		"img-src 'self' data: https://images.openfoodfacts.org"
	fsys := indexFS(`<!doctype html><html><head>` +
		`<meta http-equiv="content-security-policy" content="` + policy + `">` +
		`</head><body></body></html>`)

	mux := setupApp(t, fsys)

	t.Run("app routes get the full policy", func(t *testing.T) {
		want := policy + "; " + baselineCSP
		for _, url := range []string{"/probe", "/api/collections/category_templates/records"} {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
			if got := rec.Header().Get("Content-Security-Policy"); got != want {
				t.Errorf("%s: Content-Security-Policy = %q, want %q", url, got, want)
			}
		}
	})

	// PocketBase sets its own policy where none is set: its dashboard's, and
	// the sandbox on the files it serves.
	t.Run("dashboard and files keep PocketBase's own", func(t *testing.T) {
		for _, url := range []string{"/_/", "/_/index.html", "/api/files/c/r/f.png"} {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
			if got := rec.Header().Get("Content-Security-Policy"); got != "" {
				t.Errorf("%s: Content-Security-Policy = %q, want none of ours", url, got)
			}
		}
	})
}

// A build whose index.html lost its policy, or whose tag the pattern no
// longer reads, stops the start instead of serving the app without one.
func TestLoadCSP_RefusesAnIndexWithoutItsPolicy(t *testing.T) {
	for name, html := range map[string]string{
		"no tag":       "<!doctype html><html><head></head><body></body></html>",
		"empty policy": `<meta http-equiv="content-security-policy" content=" ;">`,
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("loadCSP served an index.html without its policy")
				}
			}()
			loadCSP(indexFS(html))
		})
	}
}

func TestLoadCSP_TrimsTrailingSemicolon(t *testing.T) {
	fsys := indexFS(`<meta http-equiv="content-security-policy" content="default-src 'self';">`)
	if got, want := loadCSP(fsys), "default-src 'self'; "+baselineCSP; got != want {
		t.Errorf("loadCSP = %q, want %q", got, want)
	}
}

// [D-218] With the scanner off the camera is denied like every other
// unused feature; nothing else in the policy moves.
func TestRegister_CameraDeniedWithScannerOff(t *testing.T) {
	mux := setupAppCamera(t, nil, false)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probe", nil))
	got := rec.Header().Get("Permissions-Policy")
	if !strings.Contains(got, "camera=()") || strings.Contains(got, "camera=(self)") {
		t.Errorf("Permissions-Policy = %q, want the camera denied", got)
	}
	if want := strings.Replace(permissionsPolicy, "camera=(self)", "camera=()", 1); got != want {
		t.Errorf("Permissions-Policy = %q, want %q — only the camera may change", got, want)
	}
	if !strings.Contains(got, "publickey-credentials-get=(self)") {
		t.Errorf("Permissions-Policy = %q lost the passkey allowance", got)
	}
}
