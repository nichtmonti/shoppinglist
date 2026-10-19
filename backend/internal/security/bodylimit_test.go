package security_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// A route on AppRoutes with nothing of its own takes at most SmallBodyMax; one
// that binds LargeBody takes PocketBase's default again; PocketBase's own
// routes, outside the group, keep theirs.
func TestAppRoutesDefaultToTheSmallLimit(t *testing.T) {
	app := testutil.NewApp(t)
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	read := func(e *core.RequestEvent) error {
		var body map[string]any
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("unreadable", err)
		}
		return e.NoContent(http.StatusNoContent)
	}
	g := security.AppRoutes(r)
	g.POST("/api/plain", read)
	g.POST("/api/large", read).Bind(security.LargeBody())
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	post := func(path string, size int) int {
		body := `{"a":"` + strings.Repeat("x", size-8) + `"}`
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res.Code
	}
	over := security.SmallBodyMax + 1
	for _, tc := range []struct {
		path string
		size int
		want int
	}{
		{"/api/plain", security.SmallBodyMax, http.StatusNoContent},
		{"/api/plain", over, http.StatusRequestEntityTooLarge},
		{"/api/large", over, http.StatusNoContent},
		// PocketBase's own route reads the body and refuses its missing client id,
		// which it could not do past a 64 KiB limit.
		{"/api/realtime", over, http.StatusBadRequest},
	} {
		if got := post(tc.path, tc.size); got != tc.want {
			t.Errorf("POST %s with %d bytes = %d, want %d", tc.path, tc.size, got, tc.want)
		}
	}
}
