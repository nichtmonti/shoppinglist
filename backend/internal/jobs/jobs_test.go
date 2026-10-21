package jobs

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// TestRegisterAddsAllJobs proves every §13 cron schedule parses and registers.
func TestRegisterAddsAllJobs(t *testing.T) {
	app := testutil.NewApp(t)
	before := app.Cron().Total()
	if err := Register(app); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if got, want := app.Cron().Total()-before, len(jobs); got != want {
		t.Errorf("registered %d cron jobs, want %d", got, want)
	}
}

// A failed backup reaches the container log ([D-334]): PocketBase's own report
// goes only to the dashboard and to superusers' mail.
func TestFailedBackupIsLogged(t *testing.T) {
	app := testutil.NewApp(t)
	if err := Register(app); err != nil {
		t.Fatalf("Register: %v", err)
	}
	app.OnBackupCreate().BindFunc(func(*core.BackupEvent) error { return errors.New("disk full") })
	logged := testutil.CaptureLog(t)

	if err := app.CreateBackup(context.Background(), "nightly.zip"); err == nil {
		t.Fatal("CreateBackup succeeded, want the hook's error")
	}
	if got := logged.String(); !strings.Contains(got, `level=ERROR msg="shoppinglist: backup failed" error="disk full" name=nightly.zip`) {
		t.Errorf("container log = %q, want the failed backup named", got)
	}
}
