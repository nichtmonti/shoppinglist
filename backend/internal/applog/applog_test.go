package applog_test

import (
	"errors"
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

	want := "shoppinglist: orphan_sweep failed: boom account=abc123\n" +
		"shoppinglist: WARNING counter did not advance sign_count=0\n" +
		"shoppinglist: seed applied version=10"
	if got := strings.TrimSpace(logs.String()); got != want {
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

	want := `shoppinglist: sweep failed: "a\nb" reason="x account=forged" empty=""`
	if got := strings.TrimSpace(logs.String()); got != want {
		t.Errorf("container log = %q, want %q", got, want)
	}
}
