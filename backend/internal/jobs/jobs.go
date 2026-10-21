// Package jobs schedules the shoppinglist background cron jobs
// (docs/internals/design.md §13). Each sweep lives with the package that owns
// its table; this one runs them and logs their failures, and those of
// PocketBase's scheduled backup.
package jobs

import (
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/account"
	"shoppinglist/internal/applog"
	"shoppinglist/internal/barcode"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/sync"
)

const daily = "0 3 * * *" // 03:00 UTC

type job struct {
	name, schedule string
	sweep          func(core.App) error
	// window is the age the sweep acts on, for the docs' tables.
	window time.Duration
}

// jobs are the §13 cron jobs. Each comment is what the job does in
// docs/operating.md's table, where {window} is its window; that table and
// design.md's are rendered from this one by this package's test.
var jobs = []job{
	// **Deletes** items and categories removed more than {window} ago, except
	// items remembered under *Previous items* and the built-in aisles a list
	// removed
	{"tombstone_gc", daily, sync.SweepTombstones, sync.Horizon},
	// Deletes invite links that expired, or were revoked or replaced, more
	// than {window} ago
	{"invite_sweep", daily, invites.Sweep, invites.SweepAfter},
	// **Deletes** accounts that are on no list, are older than {window} and
	// have used no passkey in {window}
	{"orphan_sweep", daily, account.SweepOrphans, account.OrphanAfter},
	// Deletes product lookups and photos older than {window} that no item
	// still shows
	{"barcode_photo_sweep", daily, barcode.SweepPhotos, barcode.PhotoSweepAfter},
	// Downloads again, from the Open Food Facts photo hosts, product photos
	// whose download failed in the last {window}
	{"barcode_photo_retry", "*/15 * * * *", barcode.RetryPhotos, barcode.PhotoRetryWindow},
	// Deletes records of duplicate items merged during sync, after {window}
	{"merge_log_sweep", daily, sync.SweepMergeLog, sync.Horizon},
}

// Register adds all §13 cron jobs to the app scheduler. It must run after the
// migrations, e.g. from an OnServe hook. Returns the first registration error.
func Register(app core.App) error {
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
