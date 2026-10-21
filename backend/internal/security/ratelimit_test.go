// External test package — see listguard_test.go for why.
package security_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// setupRateLimitApp mounts a single test route behind a budget of its own,
// 3 a minute, so the real §10 budgets are never touched.
func setupRateLimitApp(t *testing.T) http.Handler {
	t.Helper()
	app := testutil.NewApp(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	ok := func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]string{"ok": "true"})
	}
	router.POST("/api/test", ok).BindFunc(security.Limit("test_budget", time.Minute, 3))
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return mux
}

// TestRateLimitBudgetPerApp: the middleware enforces the budget (3/min), and
// a spent bucket belongs to its app: another app's router starts full.
func TestRateLimitBudgetPerApp(t *testing.T) {
	mux := setupRateLimitApp(t)
	req := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/test", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		return rec
	}
	for i := range 3 {
		if rec := req(); rec.Code != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, want 200: %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if rec := req(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("4th attempt status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
	fresh := setupRateLimitApp(t)
	rec := httptest.NewRecorder()
	fresh.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/test", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("another app's first attempt status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// TestRateLimitUnknownBudgetPanics: an unknown budget name is a programmer
// error, surfaced as a panic at BIND time — when security.RateLimit(...) is called and
// the route table is assembled — rather than a silent no-op or a panic
// swallowed mid-request by the router's recover middleware.
func TestRateLimitUnknownBudgetPanics(t *testing.T) {
	app := testutil.NewApp(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	ok := func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]string{"ok": "true"})
	}
	// The panic must land while the test's recover is armed, so the defer
	// precedes the bind — the validation fires when security.RateLimit(...) is
	// called, not when the route serves.
	defer func() {
		if recover() == nil {
			t.Error("security.RateLimit(\"no_such_budget\") did not panic")
		}
	}()
	router.POST("/api/test", ok).BindFunc(security.RateLimit("no_such_budget"))
}

// TestRateLimitIPv6SharesThePrefix: through the middleware, two addresses of
// one /64 spend one budget, and another /64 has its own.
func TestRateLimitIPv6SharesThePrefix(t *testing.T) {
	mux := setupRateLimitApp(t)
	req := func(remote string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/test", nil)
		r.RemoteAddr = remote
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		return rec.Code
	}
	for i := range 3 {
		if code := req(fmt.Sprintf("[2001:db8:0:1::%x]:4000", i+1)); code != http.StatusOK {
			t.Fatalf("attempt %d = %d, want 200", i+1, code)
		}
	}
	if code := req("[2001:db8:0:1::ff]:4000"); code != http.StatusTooManyRequests {
		t.Errorf("a fourth address of the same /64 = %d, want 429", code)
	}
	if code := req("[2001:db8:0:2::1]:4000"); code != http.StatusOK {
		t.Errorf("another /64 = %d, want 200", code)
	}
}
