package applog_test

import (
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/testutil"
)

// An event reaches the container log, not only PocketBase's, which an
// instance with SHOPPINGLIST_ADMIN_UI=off has no way to read.
func TestEventsReachTheContainerLog(t *testing.T) {
	app := testutil.NewApp(t)
	logs := testutil.CaptureLog(t)

	applog.Error(app, "orphan_sweep failed", errors.New("boom"), "account", "abc123")
	applog.Warn(app, "counter did not advance", nil, "sign_count", 0)
	applog.Info(app, "seed applied", "version", "10")

	want := `level=ERROR msg="shoppinglist: orphan_sweep failed" error=boom account=abc123` + "\n" +
		`level=WARN msg="shoppinglist: counter did not advance" sign_count=0` + "\n" +
		`level=INFO msg="shoppinglist: seed applied" version=10`
	if got := untimed(logs.String()); got != want {
		t.Errorf("container log = %q, want %q", got, want)
	}
}

// A value cannot split the line or forge a key=value pair: one that needs it
// is quoted, an error joined from two included.
func TestValuesStayOnTheirLine(t *testing.T) {
	app := testutil.NewApp(t)
	logs := testutil.CaptureLog(t)

	applog.Error(app, "sweep failed", errors.Join(errors.New("a"), errors.New("b")),
		"reason", "x account=forged", "empty", "")

	want := `level=ERROR msg="shoppinglist: sweep failed" error="a\nb" reason="x account=forged" empty=""`
	if got := untimed(logs.String()); got != want {
		t.Errorf("container log = %q, want %q", got, want)
	}
}

// untimed is the captured lines without slog's leading time=…, which changes
// with every run.
func untimed(s string) string {
	return regexp.MustCompile(`(?m)^time=\S+ `).ReplaceAllString(strings.TrimSpace(s), "")
}

// A 500's cause reaches the container log, a recovered panic's included, by
// the route's pattern rather than its path; a refusal (4xx) stays out.
func TestServerErrorsLogTheCause(t *testing.T) {
	app := testutil.NewApp(t)
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	r.Bind(applog.ServerErrors())
	r.GET("/fail/{token}", func(e *core.RequestEvent) error {
		return e.InternalServerError("lookup failed", errors.New("database is locked"))
	})
	r.GET("/panic", func(*core.RequestEvent) error { panic("nil map") })
	r.GET("/refuse", func(e *core.RequestEvent) error { return e.ForbiddenError("no", nil) })
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	logs := testutil.CaptureLog(t)

	for _, path := range []string{"/fail/secret-token", "/panic", "/refuse"} {
		testutil.DoReq(mux, "GET", path, "", nil)
	}

	got := untimed(logs.String())
	want := `level=ERROR msg="shoppinglist: request failed" error="database is locked" route="GET /fail/{token}" status=500 message="Lookup failed."`
	if line, _, _ := strings.Cut(got, "\n"); line != want {
		t.Errorf("first line = %q, want %q", line, want)
	}
	if !strings.Contains(got, `route="GET /panic"`) || !strings.Contains(got, "nil map") {
		t.Errorf("the recovered panic is not logged with its cause:\n%s", got)
	}
	if strings.Contains(got, "secret-token") || strings.Contains(got, "/refuse") {
		t.Errorf("logged a path or a refusal:\n%s", got)
	}
}
