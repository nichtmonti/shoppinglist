package security

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil/testapp"
)

// A forwarding header while none is trusted is warned about once per start,
// and not at all once the app trusts one.
func TestProxyHeaderHintWarnsOnce(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		app := testapp.New(t)
		if trusted {
			app.Settings().TrustedProxy.Headers = []string{"X-Forwarded-For"}
		}
		r, err := apis.NewRouter(app)
		if err != nil {
			t.Fatal(err)
		}
		r.BindFunc(ProxyHeaderHint())
		r.GET("/probe", func(e *core.RequestEvent) error { return e.NoContent(http.StatusNoContent) })
		mux, err := r.BuildMux()
		if err != nil {
			t.Fatal(err)
		}
		var logs bytes.Buffer
		prev := log.Writer()
		log.SetOutput(&logs)

		for range 2 {
			req := httptest.NewRequest(http.MethodGet, "/probe", nil)
			req.Header.Set("X-Forwarded-For", "203.0.113.7")
			mux.ServeHTTP(httptest.NewRecorder(), req)
		}
		log.SetOutput(prev)

		want := 1
		if trusted {
			want = 0
		}
		if got := strings.Count(logs.String(), "requests carry a X-Forwarded-For header"); got != want {
			t.Errorf("trusted=%v: %d warnings, want %d:\n%s", trusted, got, want, logs.String())
		}
	}
}
