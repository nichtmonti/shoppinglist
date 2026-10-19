package sync

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shoppinglist/internal/testutil"
)

// TestPushRateLimited (§10): the push route is rate-limited per IP
// (300/5min). Uses a dedicated RemoteAddr (TEST-NET-3, 203.0.113.0/24)
// instead of httptest's default 192.0.2.1 so saturating RateSyncPush cannot
// poison the bucket for any other test sharing that default IP — the same
// pattern as backend/internal/invites TestPreviewRateLimited.
func TestPushRateLimited(t *testing.T) {
	app, mux := setupSyncApp(t)
	_, tok := testutil.CreateAccount(t, app, "ratelimit")
	const ip = "203.0.113.20:1"

	pushReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/sync/push", strings.NewReader(`{"ops":[]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	// Every request under the cap is a legit empty drain (200, {"results":[]}) —
	// proving the limiter never eats real traffic.
	for i := range 300 {
		rec := pushReq()
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d: rate-limited too early: %s", i+1, rec.Body.String())
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, want 200: %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if rec := pushReq(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("301st push attempt status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
}
