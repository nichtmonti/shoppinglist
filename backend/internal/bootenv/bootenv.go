// Package bootenv turns deployment-provided environment variables into
// PocketBase configuration: the SQLite DSN pragmas (SQLITE_PRAGMAS) and the
// admin-settings seeds (SHOPPINGLIST_APP_URL, SHOPPINGLIST_TRUSTED_PROXY_HEADER,
// SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST), plus the app's own name. With none set,
// the app boots like stock PocketBase apart from that name ([D-65]). The OIDC
// variables are internal/oidc's.
package bootenv

import (
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/envflag"
)

// SQLITE_PRAGMAS is deliberately unprefixed: it names the sqlite driver's own
// DSN knobs.
const (
	pragmaEnv       = "SQLITE_PRAGMAS"
	AppURLEnv       = "SHOPPINGLIST_APP_URL"
	trustedProxyEnv = "SHOPPINGLIST_TRUSTED_PROXY_HEADER"
	leftmostIPEnv   = "SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST"
)

// readerPoolCap is the DataMaxOpenConns applied when SQLITE_PRAGMAS is set.
// Upstream's 120 readers are sized for WAL; under a rollback journal, the
// reason the override exists, they only contend for the file lock.
const readerPoolCap = 16

// NewApp constructs the application with the deployment's DB configuration.
// With SQLITE_PRAGMAS unset it returns stock pocketbase.New(); with it set,
// every connection to data.db and auxiliary.db carries the operator's pragmas
// instead of core.DefaultDBConnect's WAL DSN.
func NewApp() *pocketbase.PocketBase {
	if pragmaSuffix() == "" {
		return pocketbase.New()
	}
	return pocketbase.NewWithConfig(pocketbase.Config{
		DBConnect:        Connect,
		DataMaxOpenConns: readerPoolCap,
	})
}

// Connect is the core.DBConnectFunc used when SQLITE_PRAGMAS is set: the
// database path plus the pragma suffix. The env is read at connect time so
// tests can set it per case.
func Connect(dbPath string) (*dbx.DB, error) {
	return dbx.Open("sqlite", dbPath+pragmaSuffix())
}

// pragmaSuffix returns SQLITE_PRAGMAS normalized to a leading "?", or "" when
// unset.
func pragmaSuffix() string {
	v := envflag.Get(pragmaEnv)
	if v == "" {
		return ""
	}
	if !strings.HasPrefix(v, "?") {
		v = "?" + v
	}
	return v
}

// Register binds the settings seed to OnBootstrap. Call it before app.Execute(),
// since every subcommand that opens the database bootstraps, not just serve.
func Register(app core.App) {
	app.OnBootstrap().Bind(&hook.Handler[*core.BootstrapEvent]{
		Id: "shoppinglist_bootenv",
		Func: func(e *core.BootstrapEvent) error {
			// Settings load inside the chain's default callback, so the
			// seed must run after e.Next().
			if err := e.Next(); err != nil {
				return err
			}
			return ApplySettings(e.App)
		},
	})
}

// AppName is the app's name wherever something outside its own UI shows one:
// the PocketBase dashboard and the OS passkey picker ([D-222], [D-223]).
const AppName = "Shoppinglist"

// ApplySettings seeds the admin settings from the environment and saves only
// when something changed, so a boot is not a write. A set variable wins over
// the admin UI, and an invalid one is a boot error naming it ([D-61]).
func ApplySettings(app core.App) error {
	s := app.Settings()

	var changed bool

	// Not a variable: set at every boot, so a dashboard edit does not stick.
	if s.Meta.AppName != AppName {
		s.Meta.AppName = AppName
		changed = true
	}

	if v := envflag.Get(AppURLEnv); v != "" {
		if err := envflag.AbsoluteURL(v); err != nil {
			return fmt.Errorf("%s: %w", AppURLEnv, err)
		}
		if s.Meta.AppURL != v {
			s.Meta.AppURL = v
			changed = true
		}
	}

	// SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST: whether RealIP() reads the leftmost
	// value of the trusted header instead of PocketBase's rightmost. Checked
	// whether or not the header is set: a value the app cannot use fails the
	// boot ([D-61]).
	//
	// It is off by default because leftmost names the real client only if every
	// hop overwrites the header. Behind a proxy that appends (the common nginx
	// $proxy_add_x_forwarded_for idiom) the leftmost value is whatever the caller
	// sent, and every rate limit becomes bypassable by spoofing it
	// (docs/deploy-reference.md#only-if-you-run-a-proxy-chain).
	leftmost, err := envflag.OnOff(leftmostIPEnv, false)
	if err != nil {
		return err
	}
	header := envflag.Get(trustedProxyEnv)
	if header == "" && envflag.Get(leftmostIPEnv) != "" {
		applog.Warn(app, leftmostIPEnv+" has no effect without "+trustedProxyEnv, nil)
	}

	if header == "" && len(s.TrustedProxy.Headers) > 0 {
		// Unset leaves the stored header (a set variable wins, unset seeds
		// nothing), so commenting the variable out does not stop trusting it:
		// without a proxy in front, any client could then pick its own rate
		// limit by sending the header.
		applog.Warn(app, fmt.Sprintf("the app trusts the %s header for the client's address, "+
			"though %s is unset: a value from an earlier start or the dashboard is still in its settings. "+
			"Without a reverse proxy that sets this header, any client can send it and pick its own rate limit; "+
			"clear the header in the dashboard (/_/, Settings, Application, IP proxy headers)",
			strings.Join(s.TrustedProxy.Headers, ", "), trustedProxyEnv), nil)
	} else if header != "" {
		// Canonicalized so the stored setting reads as the admin UI writes it.
		header = http.CanonicalHeaderKey(header)
		if !slices.Equal(s.TrustedProxy.Headers, []string{header}) || s.TrustedProxy.UseLeftmostIP != leftmost {
			s.TrustedProxy.Headers = []string{header}
			s.TrustedProxy.UseLeftmostIP = leftmost
			changed = true
		}
	}

	if !changed {
		return nil
	}
	return app.Save(s)
}
