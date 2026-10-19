package security

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil/testapp"
)

// setupLockdownApp mirrors setupApp (headers_test.go) but mounts the admin
// lockdown, plus stand-ins for the two upstream surfaces it hides: PocketBase's
// dashboard and the superuser auth API. Both answer 200 when reached, so a 404
// in a test can only have come from the middleware.
func setupLockdownApp(t *testing.T, adminUI bool) http.Handler {
	t.Helper()
	app := testapp.New(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	// main.go's order: headers bound BEFORE the lockdown, whose 404 returns
	// without e.Next() — this way its 404s still carry the security headers.
	Register(router, nil, true)
	if !adminUI {
		RegisterAdminLockdown(router)
	}
	ok := func(e *core.RequestEvent) error { return e.String(http.StatusOK, "ok") }
	router.GET("/probe", ok)
	router.GET("/_/{path...}", ok)
	router.POST("/api/collections/_superusers/auth-with-password", ok)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return mux
}

func do(t *testing.T, mux http.Handler, method, path string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec.Code
}

// TestAdminLockdown_Off: the dashboard and the superuser auth API are gone.
// 404 rather than 403 is deliberate — a 403 tells a prober there is something
// there worth returning for. The 404s still carry the §10 security headers:
// the lockdown is bound after them precisely so its short-circuit does not
// strip them.
func TestAdminLockdown_Off(t *testing.T) {
	mux := setupLockdownApp(t, false)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/_/"},
		{http.MethodGet, "/_/index.html"},
		{http.MethodPost, "/api/collections/_superusers/auth-with-password"},
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", tc.method, tc.path, rec.Code)
		}
		if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("%s %s: Referrer-Policy = %q, want %q", tc.method, tc.path, got, "no-referrer")
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s %s: X-Content-Type-Options = %q, want %q", tc.method, tc.path, got, "nosniff")
		}
	}
}

// TestAdminLockdown_OffLeavesTheAppAlone: the lockdown is bound on the whole
// router, so the app's own routes must still be reachable.
func TestAdminLockdown_OffLeavesTheAppAlone(t *testing.T) {
	mux := setupLockdownApp(t, false)
	if code := do(t, mux, http.MethodGet, "/probe"); code != http.StatusOK {
		t.Errorf("GET /probe = %d, want 200", code)
	}
}

// TestAdminLockdown_On: the default is genuinely inert.
func TestAdminLockdown_On(t *testing.T) {
	mux := setupLockdownApp(t, true)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/probe"},
		{http.MethodGet, "/_/"},
		{http.MethodPost, "/api/collections/_superusers/auth-with-password"},
	} {
		if code := do(t, mux, tc.method, tc.path); code != http.StatusOK {
			t.Errorf("%s %s = %d, want 200", tc.method, tc.path, code)
		}
	}
}

// TestAdminUIFromEnv: unset means on (an upgrade must not take away the
// operator's only administration route), and an unrecognised value is fatal
// rather than defaulting — an instance believed locked down must not be open.
func TestAdminUIFromEnv(t *testing.T) {
	for _, tc := range []struct {
		value   string
		wantOn  bool
		wantErr bool
	}{
		{value: "", wantOn: true},
		{value: "on", wantOn: true},
		{value: "off", wantOn: false},
		{value: "OFF", wantOn: false},
		{value: "  off  ", wantOn: false},
		{value: "false", wantErr: true},
		{value: "disabled", wantErr: true},
	} {
		t.Setenv("SHOPPINGLIST_ADMIN_UI", tc.value)
		on, err := AdminUIFromEnv()
		if tc.wantErr {
			if err == nil {
				t.Errorf("SHOPPINGLIST_ADMIN_UI=%q should be rejected", tc.value)
			}
			continue
		}
		if err != nil {
			t.Errorf("SHOPPINGLIST_ADMIN_UI=%q: unexpected error: %v", tc.value, err)
			continue
		}
		if on != tc.wantOn {
			t.Errorf("SHOPPINGLIST_ADMIN_UI=%q = %v, want %v", tc.value, on, tc.wantOn)
		}
	}
}

// TestSuperuserAuthGuard_BlocksAuthByCollectionID is the point of the hook
// existing at all. The path prefix in RegisterAdminLockdown matches one
// spelling; the same collection is equally reachable by its system id. This
// mounts the guard WITHOUT that middleware and authenticates over the id path,
// so a pass means the block keys off collection identity, not the URL.
func TestSuperuserAuthGuard_BlocksAuthByCollectionID(t *testing.T) {
	app := testapp.New(t)

	col, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatalf("find _superusers: %v", err)
	}
	su := core.NewRecord(col)
	su.SetEmail("admin@example.com")
	su.SetPassword("hunter2hunter2")
	if err := app.Save(su); err != nil {
		t.Fatalf("save superuser: %v", err)
	}

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}

	// Addressed by collection ID, which the path prefix would not catch.
	url := "/api/collections/" + col.Id + "/auth-with-password"
	body := `{"identity":"admin@example.com","password":"hunter2hunter2"}`

	post := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	// Baseline: without the guard these credentials do authenticate, so the
	// assertion below cannot pass for some unrelated reason.
	if rec := post(); rec.Code != http.StatusOK {
		t.Fatalf("baseline auth = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	RegisterSuperuserAuthGuard(app)

	rec := post()
	if rec.Code != http.StatusForbidden {
		t.Fatalf("guarded auth = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "\"token\"") {
		t.Errorf("guarded auth leaked a token: %s", rec.Body.String())
	}
}
