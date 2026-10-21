package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/security"
)

// TestServeWiringHonoursTheOffSwitches: SHOPPINGLIST_ADMIN_UI=off and
// SHOPPINGLIST_SCANNER=off as serve wires them (registerRoutes,
// registerDomainHooks). Each half has its package's own test; this one fails
// when main drops or inverts the branch that mounts it. Off: no dashboard, no
// superuser sign-in by the collection's name or its id (§10), no barcode
// lookup while stored photos still serve ([D-218]). The defaults run first, so
// every probe is shown to tell the two apart.
func TestServeWiringHonoursTheOffSwitches(t *testing.T) {
	if demoBuild {
		t.Skip("the normal build's environment; the demo build mounts the same routes")
	}
	for _, off := range []bool{false, true} {
		name := "defaults"
		if off {
			name = "admin UI and scanner off"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
			if off {
				t.Setenv("SHOPPINGLIST_ADMIN_UI", "off")
				t.Setenv("SHOPPINGLIST_SCANNER", "off")
			}
			env, err := buildServeEnv()
			if err != nil {
				t.Fatalf("buildServeEnv: %v", err)
			}

			app := newServeApp(t)
			suCol, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
			if err != nil {
				t.Fatal(err)
			}
			su := core.NewRecord(suCol)
			su.SetEmail("admin@example.com")
			su.SetPassword("hunter2hunter2")
			if err := app.Save(su); err != nil {
				t.Fatalf("save superuser: %v", err)
			}

			mux := serveMux(t, app, env, func(r *router.Router[*core.RequestEvent]) {
				// apis.Serve mounts the dashboard, not NewRouter: a stand-in
				// takes its path, which the lockdown must refuse when off.
				r.GET("/_/{path...}", func(e *core.RequestEvent) error { return e.String(http.StatusOK, "dashboard") })
			})
			do := func(method, path, body string) (int, string) {
				req := httptest.NewRequest(method, path, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				res := httptest.NewRecorder()
				mux.ServeHTTP(res, req)
				var out struct {
					Message string `json:"message"`
				}
				_ = json.Unmarshal(res.Body.Bytes(), &out)
				return res.Code, out.Message
			}

			// The dashboard: the lockdown answers 404 in front of it.
			if code, _ := do(http.MethodGet, "/_/", ""); (code == http.StatusNotFound) != off {
				t.Errorf("GET /_/ = %d, want 404 exactly when the admin UI is off", code)
			}
			creds := `{"identity":"admin@example.com","password":"hunter2hunter2"}`
			for _, col := range []string{core.CollectionNameSuperusers, suCol.Id} {
				code, _ := do(http.MethodPost, "/api/collections/"+col+"/auth-with-password", creds)
				if (code == http.StatusOK) == off {
					t.Errorf("superuser sign-in via %s = %d, want 200 exactly when the admin UI is on", col, code)
				}
			}

			// The lookup needs a signed-in caller: 401 while mounted, the
			// router's 404 once it is gone.
			if code, _ := do(http.MethodGet, "/api/barcode/4006381333931", ""); (code == http.StatusNotFound) != off {
				t.Errorf("barcode lookup = %d, want 404 exactly when the scanner is off", code)
			}
			// The photo route stays either way: an unknown token is its own
			// "not found", not the router's.
			_, missing := do(http.MethodGet, "/api/no-such-route", "")
			code, msg := do(http.MethodGet, "/api/barcode/photo/"+strings.Repeat("ab", 16), "")
			if code != http.StatusNotFound || msg == missing {
				t.Errorf("photo route = %d %q, want the route's own 404, not the router's %q", code, msg, missing)
			}
		})
	}
}

// TestServeWiringServesTheShell: every path the app does not route is the
// stamped shell, so a deep link opens the SPA, except under /api/, where a
// route that does not exist, or is switched off, is a JSON 404: a client that
// asks a removed route must not read the shell as its answer.
func TestServeWiringServesTheShell(t *testing.T) {
	if demoBuild {
		t.Skip("the normal build's environment; the demo build mounts the same routes")
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	t.Setenv("SHOPPINGLIST_SCANNER", "off")
	env, err := buildServeEnv()
	if err != nil {
		t.Fatalf("buildServeEnv: %v", err)
	}
	app := newServeApp(t)
	mux := serveMux(t, app, env, nil)
	get := func(path string) *httptest.ResponseRecorder {
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		return res
	}

	for _, path := range []string{"/", "/list/abc123", "/import"} {
		res := get(path)
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `content="`+env.shell.Version+`"`) {
			t.Errorf("GET %s = %d %q, want the stamped shell", path, res.Code, res.Body.String())
		}
	}
	for _, path := range []string{"/api/no-such-route", "/api/barcode/4006381333931"} {
		res := get(path)
		if res.Code != http.StatusNotFound || !strings.HasPrefix(res.Header().Get("Content-Type"), "application/json") {
			t.Errorf("GET %s = %d %s, want a JSON 404", path, res.Code, res.Header().Get("Content-Type"))
		}
	}

	// A shell load stays out of the request log like any static file: a deep
	// link names a list ([D-271]). PocketBase writes the log in batches, so
	// this waits for the 404s above, which are logged, to arrive.
	var logged []string
	for deadline := time.Now().Add(10 * time.Second); !slices.Contains(logged, "/api/no-such-route"); {
		if time.Now().After(deadline) {
			t.Fatalf("request log = %q, want the 404s in it", logged)
		}
		time.Sleep(100 * time.Millisecond)
		if err := app.AuxDB().NewQuery("SELECT ifnull(json_extract(data, '$.url'), '') FROM _logs").Column(&logged); err != nil {
			t.Fatal(err)
		}
	}
	if slices.Contains(logged, "/list/abc123") {
		t.Errorf("request log = %q, want no shell load", logged)
	}
}

// newServeApp is a migrated app in a temp dir, as serve boots it.
func newServeApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir(), HideStartBanner: true})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return app
}

// serveMux mounts the routes and hooks as serve wires them for env, after
// what before mounts (nil for nothing), with fresh rate-limit budgets.
func serveMux(t *testing.T, app core.App, env *serveEnv, before func(*router.Router[*core.RequestEvent])) http.Handler {
	t.Helper()
	// A shell to serve: the no_ui build embeds none ([D-64]).
	saved := publicFS
	publicFS = fstest.MapFS{router.IndexPage: {Data: []byte(`<html><head>` +
		`<meta http-equiv="content-security-policy" content="default-src 'self'"></head><body></body></html>`)}}
	t.Cleanup(func() { publicFS = saved })
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if before != nil {
		before(r)
	}
	registerRoutes(r, env)
	registerDomainHooks(app, env)
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	return mux
}

// TestServeWiringSmallBodies: serve puts the app's routes on
// security.AppRoutes, so one from each registrar refuses a body past
// SmallBodyMax with 413 and takes one at the limit to its guard, while push
// and import keep PocketBase's default (and client-errors has a smaller one).
func TestServeWiringSmallBodies(t *testing.T) {
	if demoBuild {
		t.Skip("the normal build's environment; the demo build mounts the same routes")
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	env, err := buildServeEnv()
	if err != nil {
		t.Fatalf("buildServeEnv: %v", err)
	}
	mux := serveMux(t, newServeApp(t), env, nil)
	post := func(path string, size int) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(strings.Repeat(" ", size)))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res.Code
	}
	for _, path := range []string{"/api/passkey/login/finish", "/api/invites/preview",
		"/api/lists/x/clone", "/api/account/link"} {
		if code := post(path, security.SmallBodyMax+1); code != http.StatusRequestEntityTooLarge {
			t.Errorf("POST %s past the limit = %d, want 413", path, code)
		}
		if code := post(path, security.SmallBodyMax); code == http.StatusRequestEntityTooLarge {
			t.Errorf("POST %s at the limit = 413, want it past the body limit", path)
		}
	}
	for _, path := range []string{"/api/sync/push", "/api/lists/import"} {
		if code := post(path, security.SmallBodyMax+1); code == http.StatusRequestEntityTooLarge {
			t.Errorf("POST %s = 413, want PocketBase's default limit", path)
		}
	}
}
