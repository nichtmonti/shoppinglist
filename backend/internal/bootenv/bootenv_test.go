package bootenv

import (
	"slices"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// The names an operator sets, as the deployment reference lists them.
const (
	pragmaEnv       = "SQLITE_PRAGMAS"
	AppURLEnv       = "SHOPPINGLIST_APP_URL"
	trustedProxyEnv = "SHOPPINGLIST_TRUSTED_PROXY_HEADER"
	leftmostIPEnv   = "SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST"
)

func TestPragmaSuffix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"?_pragma=journal_mode(DELETE)", "?_pragma=journal_mode(DELETE)"},
		// A missing "?" is tolerated rather than producing a DSN the driver
		// would misread — the pragma list is the operator's, the joiner is ours.
		{"_pragma=journal_mode(DELETE)", "?_pragma=journal_mode(DELETE)"},
		{"  ?_pragma=busy_timeout(10000)  ", "?_pragma=busy_timeout(10000)"},
	}
	for _, c := range cases {
		t.Setenv(pragmaEnv, c.in)
		if got := pragmaSuffix(); got != c.want {
			t.Errorf("pragmaSuffix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestConnectAppliesEnvPragmas proves the override reaches the driver: the
// rollback-journal deployment input (the whole reason [D-65] exists) must
// come out of the database itself, not just out of our string handling.
func TestConnectAppliesEnvPragmas(t *testing.T) {
	t.Setenv(pragmaEnv,
		"?_pragma=busy_timeout(10000)&_pragma=journal_mode(DELETE)&_pragma=foreign_keys(ON)")

	db, err := Connect(t.TempDir() + "/data.db")
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer db.Close()

	var mode string
	if err := db.NewQuery("PRAGMA journal_mode").Row(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if !strings.EqualFold(mode, "delete") {
		t.Errorf("journal_mode = %q, want delete", mode)
	}

	var busy int64
	if err := db.NewQuery("PRAGMA busy_timeout").Row(&busy); err != nil {
		t.Fatalf("busy_timeout: %v", err)
	}
	if busy != 10000 {
		t.Errorf("busy_timeout = %d, want 10000", busy)
	}

	var fk int64
	if err := db.NewQuery("PRAGMA foreign_keys").Row(&fk); err != nil {
		t.Fatalf("foreign_keys: %v", err)
	}
	if fk != 1 {
		t.Errorf("foreign_keys = %d, want 1", fk)
	}
}

// TestDefaultConnectIsWAL pins the upstream behaviour the "unset = stock"
// branch of NewApp relies on: if PocketBase ever stops defaulting to WAL,
// this is the test that says so.
func TestDefaultConnectIsWAL(t *testing.T) {
	db, err := core.DefaultDBConnect(t.TempDir() + "/data.db")
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer db.Close()

	var mode string
	if err := db.NewQuery("PRAGMA journal_mode").Row(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if !strings.EqualFold(mode, "wal") {
		t.Errorf("journal_mode = %q, want wal", mode)
	}
}

func TestApplySettingsOverridesAndPersists(t *testing.T) {
	app := testutil.NewApp(t)

	t.Setenv(AppURLEnv, "https://list.example.com")
	t.Setenv(trustedProxyEnv, "x-forwarded-for")

	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}

	// app.Save triggers PocketBase's own settings hook, which reloads the
	// settings from the store — so reading them back proves persistence,
	// not just the in-memory copy.
	s := app.Settings()
	if s.Meta.AppURL != "https://list.example.com" {
		t.Errorf("AppURL = %q", s.Meta.AppURL)
	}
	if !slices.Equal(s.TrustedProxy.Headers, []string{"X-Forwarded-For"}) {
		t.Errorf("TrustedProxy.Headers = %v", s.TrustedProxy.Headers)
	}
	// The header variable does not decide this one: naming the header your
	// proxy sends must not also opt you into reading its leftmost value.
	if s.TrustedProxy.UseLeftmostIP {
		t.Error("TrustedProxy.UseLeftmostIP = true, want false without the LEFTMOST switch")
	}
}

func TestApplySettingsSavesOnlyOnChange(t *testing.T) {
	app := testutil.NewApp(t)

	saves := 0
	app.OnModelAfterUpdateSuccess().BindFunc(func(e *core.ModelEvent) error {
		if e.Model.TableName() == "_params" && e.Model.PK() == "settings" {
			saves++
		}
		return e.Next()
	})

	// The first boot names the app: one write, env set or not.
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply (no env): %v", err)
	}
	if saves != 1 {
		t.Fatalf("first boot: %d settings writes, want 1 (the app name)", saves)
	}
	if got := app.Settings().Meta.AppName; got != AppName {
		t.Errorf("AppName = %q, want %q", got, AppName)
	}

	// No env and the name already right: nothing to write.
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply (no env): %v", err)
	}
	if saves != 1 {
		t.Fatalf("unset env wrote settings again: %d writes, want 1", saves)
	}

	t.Setenv(AppURLEnv, "https://list.example.com")
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if saves != 2 {
		t.Fatalf("after change: %d settings writes, want 2", saves)
	}

	// Same env again: values already match, so a boot is not a write.
	if err := ApplySettings(app); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if saves != 2 {
		t.Fatalf("unchanged env wrote settings again: %d writes, want 2", saves)
	}
}

func TestApplySettingsRejectsBadValues(t *testing.T) {
	app := testutil.NewApp(t)

	// No scheme: PB's own is.URL (govalidator) would accept this, but every
	// absolute URL the app builds from AppURL would then be broken — the
	// boot must fail instead. Our check is deliberately stricter than PB's.
	t.Setenv(AppURLEnv, "list.example.com")
	err := ApplySettings(app)
	if err == nil || !strings.Contains(err.Error(), AppURLEnv) {
		t.Fatalf("err = %v, want it to name %s", err, AppURLEnv)
	}

}

// newBareApp builds an unbootstrapped app the way testutil.NewApp would, so
// Register's OnBootstrap binding can be exercised through a real Bootstrap() —
// the ordering (seed after the chain's settings load) is the thing under test.
func newBareApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	return pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
}

func TestRegisterSeedsAfterSettingsLoad(t *testing.T) {
	t.Setenv(AppURLEnv, "https://list.example.com")
	t.Setenv(trustedProxyEnv, "X-Forwarded-For")

	app := newBareApp(t)
	Register(app)
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	s := app.Settings()
	if s.Meta.AppURL != "https://list.example.com" {
		t.Errorf("AppURL = %q", s.Meta.AppURL)
	}
	if s.TrustedProxy.UseLeftmostIP || !slices.Equal(s.TrustedProxy.Headers, []string{"X-Forwarded-For"}) {
		t.Errorf("TrustedProxy = %+v", s.TrustedProxy)
	}
}

// A bad value must fail the boot itself — the same contract the lockdown
// switches have ([D-61]): an instance must not come up misconfigured and
// looking fine.
func TestRegisterFailsBootOnBadEnv(t *testing.T) {
	t.Setenv(AppURLEnv, "not a url")

	app := newBareApp(t)
	Register(app)
	if err := app.Bootstrap(); err == nil {
		t.Fatal("bootstrap succeeded with invalid SHOPPINGLIST_APP_URL, want failure")
	}
}

// TestNewAppWiresEnvIntoTheDataDB exercises the entrypoint main() actually
// calls, not just the config struct: with SQLITE_PRAGMAS set, the database
// PocketBase opens must carry the operator's journal mode and the shrunken
// reader pool — registering Connect proves nothing if Bootstrap never routes
// through it.
func TestNewAppWiresEnvIntoTheDataDB(t *testing.T) {
	t.Setenv(pragmaEnv, "?_pragma=busy_timeout(10000)&_pragma=journal_mode(DELETE)")

	// The config branch leaves DefaultDataDir at PocketBase's relative
	// "pb_data", so without the chdir Bootstrap would create it inside the
	// package directory.
	t.Chdir(t.TempDir())

	app := NewApp()
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	var mode string
	if err := app.ConcurrentDB().NewQuery("PRAGMA journal_mode").Row(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if !strings.EqualFold(mode, "delete") {
		t.Errorf("journal_mode = %q, want delete", mode)
	}

	// The pool cap is the other half of the override: upstream's 120
	// contending readers buy nothing under a rollback journal's whole-file
	// writer lock.
	if got := app.ConcurrentDB().(*dbx.DB).DB().Stats().MaxOpenConnections; got != readerPoolCap {
		t.Errorf("reader pool MaxOpenConnections = %d, want %d", got, readerPoolCap)
	}
}

// TestApplySettingsFlipsLeftmostWhenHeaderAlreadySet: matching headers must
// not short-circuit the save while the leftmost flag still disagrees — an
// instance carrying leftmost=on without the switch has to be flipped back OFF
// on the next boot, or it would keep a spoofable configuration forever
// precisely because the header already matched.
func TestApplySettingsFlipsLeftmostWhenHeaderAlreadySet(t *testing.T) {
	app := testutil.NewApp(t)

	saves := 0
	app.OnModelAfterUpdateSuccess().BindFunc(func(e *core.ModelEvent) error {
		if e.Model.TableName() == "_params" && e.Model.PK() == "settings" {
			saves++
		}
		return e.Next()
	})

	// The state an instance upgraded from the forced-on era carries.
	s := app.Settings()
	s.TrustedProxy.Headers = []string{"X-Forwarded-For"}
	s.TrustedProxy.UseLeftmostIP = true
	if err := app.Save(s); err != nil {
		t.Fatalf("seed dashboard state: %v", err)
	}
	saves = 0 // the seed write is not the write under test

	// Lowercase on purpose: canonicalization is what makes the header
	// comparison pass, leaving the leftmost flip as the only change driver.
	t.Setenv(trustedProxyEnv, "x-forwarded-for")
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}

	if app.Settings().TrustedProxy.UseLeftmostIP {
		t.Error("UseLeftmostIP = true, want the env to flip it back off")
	}
	if saves != 1 {
		t.Fatalf("settings writes = %d, want 1", saves)
	}

	// Fully matching now — the next boot must be quiet.
	if err := ApplySettings(app); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if saves != 1 {
		t.Fatalf("unchanged env wrote settings again: %d writes, want 1", saves)
	}
}

// TestApplySettingsPartialEnvLeavesOtherSettingsAlone: each seed is
// independently opt-in — a fleet setting only the proxy header must not have
// the app URL dragged along or reset by it.
func TestApplySettingsPartialEnvLeavesOtherSettingsAlone(t *testing.T) {
	app := testutil.NewApp(t)

	wantURL := app.Settings().Meta.AppURL

	t.Setenv(trustedProxyEnv, "X-Forwarded-For")
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}

	s := app.Settings()
	if !slices.Equal(s.TrustedProxy.Headers, []string{"X-Forwarded-For"}) {
		t.Errorf("TrustedProxy.Headers = %v, want the env value", s.TrustedProxy.Headers)
	}
	if s.Meta.AppURL != wantURL {
		t.Errorf("AppURL = %q, want untouched %q", s.Meta.AppURL, wantURL)
	}
}

// TestApplySettingsWarnsOfAStoredHeaderWithoutTheVariable: unset seeds
// nothing, so a header stored by an earlier start stays trusted after the
// variable is commented out. The boot says so, since without a proxy any
// client can then pick its own bucket.
func TestApplySettingsWarnsOfAStoredHeaderWithoutTheVariable(t *testing.T) {
	app := testutil.NewApp(t)
	out := testutil.CaptureLog(t)

	t.Setenv(trustedProxyEnv, "X-Forwarded-For")
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("a set variable warned: %s", out.String())
	}

	t.Setenv(trustedProxyEnv, "")
	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !strings.Contains(out.String(), `level=WARN msg="shoppinglist: the app trusts the X-Forwarded-For header`) {
		t.Errorf("no warning for a stored header without the variable: %q", out.String())
	}
}

// TestApplySettingsLeftmostSwitch: the two decisions are separate. Naming the
// header must not opt an operator into reading its leftmost value — that is
// only correct when every hop OVERWRITES the header, and under a proxy that
// appends it hands the caller control of their own rate-limit bucket.
func TestApplySettingsLeftmostSwitch(t *testing.T) {
	cases := []struct {
		name, env string
		want      bool
	}{
		{"unset means off", "", false},
		{"explicit off", "off", false},
		{"on", "on", true},
		{"case-insensitive", "ON", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := testutil.NewApp(t)
			t.Setenv(trustedProxyEnv, "X-Forwarded-For")
			if tc.env != "" {
				t.Setenv(leftmostIPEnv, tc.env)
			}
			if err := ApplySettings(app); err != nil {
				t.Fatalf("apply: %v", err)
			}
			if got := app.Settings().TrustedProxy.UseLeftmostIP; got != tc.want {
				t.Errorf("UseLeftmostIP = %v, want %v", got, tc.want)
			}
		})
	}
}

// A typo must fail the boot rather than silently leaving the safer default in
// place — an operator who wrote "true" and believes their limits are
// per-client should be told, the same contract every other switch has ([D-61]).
func TestApplySettingsRejectsBadLeftmostValue(t *testing.T) {
	app := testutil.NewApp(t)
	t.Setenv(trustedProxyEnv, "X-Forwarded-For")
	t.Setenv(leftmostIPEnv, "true")

	err := ApplySettings(app)
	if err == nil {
		t.Fatal("apply accepted SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST=true")
	}
	if !strings.Contains(err.Error(), leftmostIPEnv) {
		t.Errorf("error does not name the variable at fault: %v", err)
	}
}

// Without the header the switch is inert, but a value it cannot read still
// fails the boot ([D-61]): it was parsed only beside the header.
func TestApplySettingsRejectsBadLeftmostValueWithoutTheHeader(t *testing.T) {
	app := testutil.NewApp(t)
	t.Setenv(trustedProxyEnv, "")
	t.Setenv(leftmostIPEnv, "yes")

	if err := ApplySettings(app); err == nil || !strings.Contains(err.Error(), leftmostIPEnv) {
		t.Fatalf("apply accepted SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST=yes without the header: %v", err)
	}
}

// The switch is inert without the header: PocketBase only consults
// UseLeftmostIP when a trusted header is configured, so setting one without
// the other must not write settings at all.
func TestApplySettingsLeftmostAloneIsANoop(t *testing.T) {
	app := testutil.NewApp(t)
	t.Setenv(leftmostIPEnv, "on")

	if err := ApplySettings(app); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if s := app.Settings(); s.TrustedProxy.UseLeftmostIP || len(s.TrustedProxy.Headers) != 0 {
		t.Errorf("TrustedProxy = %+v, want untouched", s.TrustedProxy)
	}
}
