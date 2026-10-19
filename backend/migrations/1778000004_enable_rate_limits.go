package migrations

// §10: turn on PocketBase's own rate limiter.
//
// PocketBase ships a sensible default rule set (core/settings_model.go: *:auth
// 2/3s, *:create 20/5s, /api/batch 3/1s, /api/ 300/10s) but leaves the whole
// limiter disabled — a "@todo once tested enough" in upstream. The app's own
// budgets (internal/security) cover only its custom routes; everything under
// /api/collections/* — record create, list, update — has no limit at all
// unless this is on.
//
// This sets the INITIAL posture, it does not enforce it: migrations run once,
// so an operator who later turns the limiter off in the dashboard is not
// overridden on the next boot.
//
// PREREQUISITE, documented in docs/deploy-reference.md: the limiter buckets by
// RealIP(), which behind a reverse proxy returns the PROXY's address for every
// request unless the trusted-proxy header is configured. Without that, the
// /api/ 300/10s budget is one budget shared by every user of the instance.

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(enableRateLimitsUp, enableRateLimitsDown, "1778000004_enable_rate_limits.go")
}

func enableRateLimitsUp(app core.App) error {
	settings := app.Settings()
	settings.RateLimits.Enabled = true
	return app.Save(settings)
}

func enableRateLimitsDown(app core.App) error {
	settings := app.Settings()
	settings.RateLimits.Enabled = false
	return app.Save(settings)
}
