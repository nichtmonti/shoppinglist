// Package jobs schedules the shoppinglist background cron jobs
// (docs/internals/design.md §13). Each sweep lives with the package that owns
// its table; this one runs them and logs their failures, and those of
// PocketBase's scheduled backup.
package jobs

import (
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/account"
	"shoppinglist/internal/applog"
	"shoppinglist/internal/barcode"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/sync"
)

const daily = "0 3 * * *" // 03:00 UTC

// Register adds all §13 cron jobs to the app scheduler. It must run after the
// migrations, e.g. from an OnServe hook. Returns the first registration error.
func Register(app core.App) error {
	jobs := []struct {
		name, schedule string
		sweep          func(core.App) error
	}{
		{"tombstone_gc", daily, sync.SweepTombstones},
		{"invite_sweep", daily, invites.Sweep},
		{"orphan_sweep", daily, account.SweepOrphans},
		{"barcode_photo_sweep", daily, barcode.SweepPhotos},
		{"barcode_photo_retry", "*/15 * * * *", barcode.RetryPhotos},
		{"merge_log_sweep", daily, sync.SweepMergeLog},
	}
	for _, j := range jobs {
		if err := app.Cron().Add("__shoppinglist_"+j.name+"__", j.schedule, func() {
			if err := j.sweep(app); err != nil {
				applog.Error(app, j.name+" failed", err)
			}
		}); err != nil {
			return err
		}
	}

	// PocketBase logs a failed backup only to its own log, which
	// SHOPPINGLIST_ADMIN_UI=off hides, and mails it to superusers, who have no
	// mail here; the scheduled one is on by default ([D-334]).
	app.OnBackupCreate().BindFunc(func(e *core.BackupEvent) error {
		err := e.Next()
		if err != nil {
			applog.Error(app, "backup failed", err, "name", e.Name)
		}
		return err
	})
	return nil
}
