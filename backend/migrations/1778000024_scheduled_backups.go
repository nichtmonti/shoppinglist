// Migration 1778000024 — PocketBase's scheduled backups on: every night at
// 03:00 UTC, the newest 7 kept in pb_data/backups ([D-334]).
//
// Upstream ships them off, so an instance had none until an operator found the
// dashboard's backup settings, and one with SHOPPINGLIST_ADMIN_UI=off could not
// reach them at all. Like 1778000004 this sets the initial posture once: a
// schedule already set stands, and one changed or cleared later is not
// overridden on the next boot. Down is a no-op; an operator's schedule may
// have replaced this one.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(scheduledBackupsUp, func(core.App) error { return nil }, "1778000024_scheduled_backups.go")
}

// The schedule and how many it keeps, which docs/operating.md quotes
// (backend/docs_test.go holds it to them).
const (
	backupCron     = "0 3 * * *"
	backupKeepLast = 7
)

func scheduledBackupsUp(app core.App) error {
	settings := app.Settings()
	if settings.Backups.Cron != "" {
		return nil
	}
	settings.Backups.Cron = backupCron
	settings.Backups.CronMaxKeep = backupKeepLast
	return app.Save(settings)
}
