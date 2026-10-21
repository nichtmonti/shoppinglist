// Package demo is the public demo's way in ([D-234]): one button that signs a
// visitor in to a throwaway account, and the sweep that deletes it a day later.
//
// Only the demo build links it (backend/demo_on.go, `-tags demo`), and
// deps_arch_test.go fails if it reaches a binary built without the tag. The
// package itself carries no build tag, so `go test ./...` still tests it.
//
// FromSettings refuses passkeys and OIDC, so every account on a demo instance is a
// throwaway one: that is what lets the sweep delete by age alone.
package demo

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/account"
	"shoppinglist/internal/applog"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
	"shoppinglist/internal/settings"
)

const (
	// MaxAccountsEnv bounds how many demo accounts exist at once.
	MaxAccountsEnv = settings.DemoMaxAccountsEnv
	// StartsPerIPEnv is how many demos one address may start per StartWindow.
	StartsPerIPEnv = settings.DemoStartsPerIPEnv

	sweepJobID    = "__shoppinglist_demo_sweep__"
	sweepSchedule = "*/10 * * * *" // every 10 minutes: an account outlives Lifetime by at most that

	// startBudget is the per-IP budget on POST /api/demo/start, outside the
	// §10 table so the normal build's does not name the route; StartWindow
	// is its window.
	startBudget   = "demo_start"
	StartWindow   = 10 * time.Minute
	startsRefusal = "the demo is full right now, try again later"
)

// The caps when their settings are unset.
var (
	DefaultMaxAccounts = int(settings.DemoDefaults().MaxAccounts)
	DefaultStartsPerIP = int(settings.DemoDefaults().StartsPerIP)
)

// Lifetime is how long a demo account lives, counted from its creation. The
// field contract holds it, so the client's countdown reads the same number.
var Lifetime = time.Duration(fieldcontract.DemoLifetimeHours()) * time.Hour

// Config is the demo's part of the serve environment.
type Config struct {
	// MaxAccounts is how many demo accounts may exist at once; a start beyond
	// it is refused with 503 until the sweep frees room.
	MaxAccounts int
	// StartsPerIP is how many starts one address gets per 10 minutes.
	StartsPerIP int
}

// FromSettings validates that the instance is set up as a demo and takes its
// caps. It fails the boot with passkeys or oidc on ([D-61]).
func FromSettings(d settings.Demo, passkeys, oidc bool) (Config, error) {
	if passkeys {
		return Config{}, fmt.Errorf("the demo build needs SHOPPINGLIST_PASSKEYS=off: its accounts are deleted after %d hours, "+
			"and a passkey would leave a dead entry in every visitor's password manager", int(Lifetime.Hours()))
	}
	if oidc {
		return Config{}, fmt.Errorf("the demo build needs SHOPPINGLIST_OIDC off: every account on a demo instance " +
			"is deleted by age, a real login included")
	}
	return Config{MaxAccounts: int(d.MaxAccounts), StartsPerIP: int(d.StartsPerIP)}, nil
}

// Describe is the boot log's line for a demo instance.
func Describe(cfg Config) string {
	return fmt.Sprintf("shoppinglist: DEMO build — visitors sign in with one button, accounts are deleted %d hours "+
		"after creation, at most %d exist at once (%s), and request logging is off", int(Lifetime.Hours()), cfg.MaxAccounts, MaxAccountsEnv)
}

// RegisterRoutes mounts POST /api/demo/start.
func RegisterRoutes(r *router.RouterGroup[*core.RequestEvent], cfg Config) {
	r.POST("/api/demo/start", start(cfg)).
		BindFunc(security.Limit(startBudget, StartWindow, cfg.StartsPerIP)).
		Bind(apis.RequireGuestOnly())
}

// Register turns request logging off, stores the example products and
// schedules the sweep. Must run after the migrations, from an OnServe hook,
// like jobs.Register.
func Register(app core.App) error {
	if err := DisableLogs(app); err != nil {
		return fmt.Errorf("turn request logging off: %w", err)
	}
	if err := storeExampleProducts(app); err != nil {
		return err
	}
	return app.Cron().Add(sweepJobID, sweepSchedule, func() {
		if err := Sweep(app, time.Now()); err != nil {
			applog.Error(app, "demo sweep failed", err) // stdout first: with logging off, app.Logger() keeps nothing
		}
	})
}

// DisableLogs sets PocketBase's log retention to zero days, which stops it
// storing every request with the caller's user agent and IP address, and
// deletes rows a previous run kept. Applied at every boot, so a dashboard edit
// does not stick.
func DisableLogs(app core.App) error {
	s := app.Settings()
	if s.Logs.MaxDays == 0 {
		return nil
	}
	s.Logs.MaxDays = 0
	return app.Save(s)
}

// guestWords names a demo account in the visitor's language. The client always
// sends its locale; a request without a known one gets the German word.
var guestWords = map[string]string{"de": "Gast", "en": "Guest"}

type startBody struct {
	Lang string `json:"lang"`
}

// start handles POST /api/demo/start: a new account, signed in, answered with
// PocketBase's own auth response as after a passkey sign-up.
func start(cfg Config) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		var body startBody
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("invalid request body", err)
		}
		col, err := e.App.FindCachedCollectionByNameOrId("accounts")
		if err != nil {
			return e.InternalServerError("accounts collection missing", err)
		}
		word, ok := guestWords[body.Lang]
		if !ok {
			word = guestWords["de"]
		}
		rec := core.NewRecord(col)
		rec.Id = randid.ID()
		rec.Set("handle", randid.Handle())
		// #nosec G404 -- a display name, not a secret.
		rec.Set("nickname", fmt.Sprintf("%s %04d", word, rand.IntN(10000)))
		rec.SetRandomPassword()
		// The count inside the transaction that saves, so two starts racing at
		// the cap cannot both pass.
		err = e.App.RunInTransaction(func(txApp core.App) error {
			n, err := txApp.CountRecords("accounts")
			if err != nil {
				return err
			}
			if int(n) >= cfg.MaxAccounts {
				return e.Error(http.StatusServiceUnavailable, startsRefusal, nil)
			}
			// SaveNoValidate as passkey sign-up does: the row has no email, which
			// the auth collection's own validation would ask for.
			return txApp.SaveNoValidate(rec)
		})
		if err != nil {
			return security.RefusalOr500(e, "failed to create the demo account", err)
		}
		return apis.RecordAuthResponse(e, rec, "demo", nil)
	}
}

// Sweep deletes every account created more than Lifetime before now through
// account.DeleteAccount, the §4.5 teardown with its §7.3 cascade. An account
// that fails does not stop the others; every failure is returned, joined.
func Sweep(app core.App, now time.Time) error {
	expired, err := app.FindRecordsByFilter("accounts", "created < {:cutoff}", "", 0, 0,
		dbx.Params{"cutoff": now.Add(-Lifetime).UTC().Format(types.DefaultDateLayout)})
	if err != nil {
		return fmt.Errorf("find expired accounts: %w", err)
	}
	var errs []error
	for _, rec := range expired {
		if err := account.DeleteAccount(context.Background(), app, rec); err != nil {
			errs = append(errs, fmt.Errorf("delete account %s: %w", rec.Id, err))
		}
	}
	return errors.Join(errs...)
}
