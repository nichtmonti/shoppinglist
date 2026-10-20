package applog_test

import (
	"errors"
	"regexp"
	"strings"
	"testing"

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
