package demo

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/logger"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/account"
	"shoppinglist/internal/lists"
	"shoppinglist/internal/testutil"
)

func TestFromEnv(t *testing.T) {
	t.Run("passkeys on is refused", func(t *testing.T) {
		if _, err := FromEnv(true, false); err == nil || !strings.Contains(err.Error(), "SHOPPINGLIST_PASSKEYS=off") {
			t.Fatalf("err = %v, want a refusal naming SHOPPINGLIST_PASSKEYS=off", err)
		}
	})
	t.Run("OIDC on is refused", func(t *testing.T) {
		if _, err := FromEnv(false, true); err == nil || !strings.Contains(err.Error(), "SHOPPINGLIST_OIDC") {
			t.Fatalf("err = %v, want a refusal naming SHOPPINGLIST_OIDC", err)
		}
	})
	t.Run("the cap defaults", func(t *testing.T) {
		t.Setenv(MaxAccountsEnv, "")
		cfg, err := FromEnv(false, false)
		if err != nil || cfg.MaxAccounts != DefaultMaxAccounts {
			t.Fatalf("FromEnv = %+v, %v; want MaxAccounts %d", cfg, err, DefaultMaxAccounts)
		}
	})
	t.Run("the cap is read", func(t *testing.T) {
		t.Setenv(MaxAccountsEnv, "25")
		cfg, err := FromEnv(false, false)
		if err != nil || cfg.MaxAccounts != 25 {
			t.Fatalf("FromEnv = %+v, %v; want MaxAccounts 25", cfg, err)
		}
	})
	t.Run("the start budget defaults and is read", func(t *testing.T) {
		t.Setenv(StartsPerIPEnv, "")
		if cfg, err := FromEnv(false, false); err != nil || cfg.StartsPerIP != DefaultStartsPerIP {
			t.Fatalf("FromEnv = %+v, %v; want StartsPerIP %d", cfg, err, DefaultStartsPerIP)
		}
		t.Setenv(StartsPerIPEnv, "1000")
		if cfg, err := FromEnv(false, false); err != nil || cfg.StartsPerIP != 1000 {
			t.Fatalf("FromEnv = %+v, %v; want StartsPerIP 1000", cfg, err)
		}
		t.Setenv(StartsPerIPEnv, "0")
		if _, err := FromEnv(false, false); err == nil {
			t.Fatal("a start budget of 0 was accepted")
		}
	})
	t.Run("a bad cap fails the boot", func(t *testing.T) {
		t.Setenv(MaxAccountsEnv, "lots")
		if _, err := FromEnv(false, false); err == nil {
			t.Fatal("an unparseable cap was accepted")
		}
	})
}

// setup serves the demo routes with cfg; a zero StartsPerIP is FromEnv's default.
func setup(t *testing.T, cfg Config) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	cfg.StartsPerIP = cmp.Or(cfg.StartsPerIP, DefaultStartsPerIP)
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) { RegisterRoutes(r, cfg) })
	account.Register(app, account.Options{Passkeys: true})
	lists.Register(app)
	return app, mux
}

func countAccounts(t *testing.T, app core.App) int {
	t.Helper()
	n, err := app.CountRecords("accounts")
	if err != nil {
		t.Fatalf("count accounts: %v", err)
	}
	return int(n)
}

func TestStart(t *testing.T) {
	app, mux := setup(t, Config{MaxAccounts: 10})

	for _, tc := range []struct{ body, word string }{
		{`{"lang":"de"}`, "Gast"},
		{`{"lang":"en"}`, "Guest"},
		{`{}`, "Gast"},
	} {
		rec, body := testutil.DoReq(mux, http.MethodPost, "/api/demo/start", tc.body, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d, body %s", tc.body, rec.Code, body)
		}
		var resp struct {
			Token  string `json:"token"`
			Record struct {
				Id       string `json:"id"`
				Nickname string `json:"nickname"`
			} `json:"record"`
		}
		if err := json.Unmarshal([]byte(body), &resp); err != nil {
			t.Fatalf("decode %s: %v", body, err)
		}
		if resp.Token == "" {
			t.Errorf("%s: no token — the client could not sign in", tc.body)
		}
		if !regexp.MustCompile(`^` + tc.word + ` \d{4}$`).MatchString(resp.Record.Nickname) {
			t.Errorf("%s: nickname %q, want %q and four digits", tc.body, resp.Record.Nickname, tc.word)
		}
		stored, err := app.FindRecordById("accounts", resp.Record.Id)
		if err != nil {
			t.Fatalf("the account was not stored: %v", err)
		}
		if stored.Email() != "" {
			t.Errorf("the account has an email (%q); a demo account stores nothing about its visitor", stored.Email())
		}
	}

	t.Run("a signed-in caller is refused", func(t *testing.T) {
		app, mux := setup(t, Config{MaxAccounts: 10}) // a fresh rate-limit bucket
		_, tok := testutil.CreateAccount(t, app, "x")
		rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/demo/start", `{}`, testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status %d, want 400", rec.Code)
		}
	})
}

func TestStartCap(t *testing.T) {
	app, mux := setup(t, Config{MaxAccounts: 1})
	testutil.CreateAccount(t, app, "first")
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/demo/start", `{}`, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d at the cap, want 503", rec.Code)
	}
	if got := countAccounts(t, app); got != 1 {
		t.Errorf("%d accounts, want the cap of 1", got)
	}
}

func TestStartRateLimit(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  Config
		want int
	}{
		{"the default", Config{MaxAccounts: 100}, DefaultStartsPerIP},
		{"a configured budget", Config{MaxAccounts: 100, StartsPerIP: 5}, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, mux := setup(t, tc.cfg)
			for i := range tc.want {
				if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/demo/start", `{}`, nil); rec.Code != http.StatusOK {
					t.Fatalf("start %d: status %d, body %s", i+1, rec.Code, body)
				}
			}
			if rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/demo/start", `{}`, nil); rec.Code != http.StatusTooManyRequests {
				t.Errorf("start %d from one IP: status %d, want 429", tc.want+1, rec.Code)
			}
		})
	}
}

// backdate moves an account's creation back by age.
func backdate(t *testing.T, app core.App, id string, age time.Duration) {
	t.Helper()
	created, err := types.ParseDateTime(time.Now().Add(-age))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("UPDATE accounts SET created = {:c} WHERE id = {:id}").
		Bind(dbx.Params{"c": created.String(), "id": id}).Execute(); err != nil {
		t.Fatalf("backdate: %v", err)
	}
}

func TestSweep(t *testing.T) {
	app, _ := setup(t, Config{MaxAccounts: 10})

	old, _ := testutil.CreateAccount(t, app, "old")
	oldList := testutil.CreateListFor(t, app, old, "old's own")
	shared := testutil.CreateListFor(t, app, old, "shared")
	young, _ := testutil.CreateAccount(t, app, "young")
	testutil.AddMembership(t, app, young, shared)
	backdate(t, app, old, Lifetime+time.Minute)
	backdate(t, app, young, Lifetime-time.Minute)

	if err := Sweep(app, time.Now()); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := app.FindRecordById("accounts", old); err == nil {
		t.Error("an account past its lifetime survived the sweep")
	}
	if _, err := app.FindRecordById("accounts", young); err != nil {
		t.Errorf("an account inside its lifetime was deleted: %v", err)
	}
	if _, err := app.FindRecordById("lists", oldList); err == nil {
		t.Error("the expired account's own list survived — the §7.3 cascade did not run")
	}
	if _, err := app.FindRecordById("lists", shared); err != nil {
		t.Errorf("a list another visitor is still on was deleted: %v", err)
	}
}

// TestDisableLogs pins what "request logging off" has to mean: a request
// leaves no row behind. It first shows the test can see a row at all, with
// PocketBase's default retention, so the second half is not passing on a
// query that never finds anything.
func TestDisableLogs(t *testing.T) {
	app, mux := setup(t, Config{MaxAccounts: 10})

	logged := func() int {
		t.Helper()
		h, ok := app.Logger().Handler().(*logger.BatchHandler)
		if !ok {
			t.Fatalf("the app logger is a %T, not PocketBase's batch handler", app.Logger().Handler())
		}
		if err := h.WriteAll(context.Background()); err != nil {
			t.Fatalf("flush logs: %v", err)
		}
		var n int
		if err := app.AuxDB().NewQuery("SELECT COUNT(*) FROM _logs").Row(&n); err != nil {
			t.Fatalf("count logs: %v", err)
		}
		return n
	}

	if app.Settings().Logs.MaxDays == 0 {
		t.Fatal("the test app already has logging off; the control half below would prove nothing")
	}
	testutil.DoReq(mux, http.MethodPost, "/api/demo/start", `{}`, nil)
	// PocketBase hands the request's log line to a goroutine, so give it a moment.
	deadline := time.Now().Add(5 * time.Second)
	for logged() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if logged() == 0 {
		t.Fatal("with PocketBase's default retention a request left no log row — the check below cannot see one")
	}

	if err := DisableLogs(app); err != nil {
		t.Fatalf("DisableLogs: %v", err)
	}
	if app.Settings().Logs.MaxDays != 0 {
		t.Fatalf("Logs.MaxDays = %d, want 0", app.Settings().Logs.MaxDays)
	}
	if n := logged(); n != 0 {
		t.Errorf("%d log row(s) survived turning logging off — saving the setting should delete them", n)
	}
	testutil.DoReq(mux, http.MethodPost, "/api/demo/start", `{}`, nil)
	time.Sleep(200 * time.Millisecond) // the same goroutine, had it fired
	if n := logged(); n != 0 {
		t.Errorf("a request with logging off left %d log row(s)", n)
	}
}

func TestRegisterSchedulesTheSweep(t *testing.T) {
	app, _ := setup(t, Config{MaxAccounts: 10})
	before := app.Cron().Total()
	if err := Register(app); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if got := app.Cron().Total() - before; got != 1 {
		t.Errorf("registered %d cron jobs, want the sweep", got)
	}
	if app.Settings().Logs.MaxDays != 0 {
		t.Error("Register left request logging on")
	}
}

// Every example product is in the barcode cache with its photo after boot,
// twice over, as a restart does it again: the example lists show their
// pictures with no network ([D-234]).
func TestRegisterStoresTheExampleProducts(t *testing.T) {
	app, _ := setup(t, Config{MaxAccounts: 10})
	for range 2 {
		if err := Register(app); err != nil {
			t.Fatalf("Register: %v", err)
		}
	}
	for _, p := range exampleProducts {
		rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:b}", dbx.Params{"b": p.ean})
		if err != nil {
			t.Fatalf("%s: %v", p.ean, err)
		}
		if !rec.GetBool("found") || rec.GetString("photo") == "" || rec.GetString("photo_token") == "" {
			t.Errorf("%s: found %v, photo %q, token %q; want a found product with its photo",
				p.ean, rec.GetBool("found"), rec.GetString("photo"), rec.GetString("photo_token"))
		}
	}
}
