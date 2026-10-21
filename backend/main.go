// shoppinglist — application entrypoint. The SPA is compiled into the binary
// and served by an explicit static route (public_embed.go, [D-64]).
package main

import (
	"fmt"
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/cmd"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"shoppinglist/internal/account"
	"shoppinglist/internal/applog"
	"shoppinglist/internal/barcode"
	"shoppinglist/internal/bootenv"
	"shoppinglist/internal/clienterrors"
	"shoppinglist/internal/curate"
	"shoppinglist/internal/health"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/jobs"
	"shoppinglist/internal/lists"
	"shoppinglist/internal/oidc"
	"shoppinglist/internal/security"
	"shoppinglist/internal/settings"
	"shoppinglist/internal/sync"
	"shoppinglist/internal/ui"
	"shoppinglist/internal/upgradebackup"
	"shoppinglist/internal/webauthn"
	_ "shoppinglist/migrations" // register collection migrations (§6, §11)
	"shoppinglist/seed"
)

// version and commit are stamped at link time (`-X main.version=...
// -X main.commit=...`, explicit in .goreleaser.yaml). An unstamped build
// reports "dev".
var (
	version = "dev"
	commit  = ""
)

// versionString is what `shoppinglist --version` and the startup banner
// print. The short commit tells a :latest user which build they are on.
func versionString() string {
	if commit == "" {
		return version
	}
	return version + " (" + commit[:min(7, len(commit))] + ")"
}

func main() {
	// Before anything else, including pocketbase.New(): the healthcheck must
	// not bootstrap the app and open the database (see internal/health).
	if len(os.Args) > 1 && os.Args[1] == health.CommandName {
		check := health.NewCommand()
		check.SetArgs(os.Args[2:])
		if err := check.Execute(); err != nil {
			log.Println(err)
			os.Exit(1)
		}
		return
	}

	// [D-65] SQLite pragmas from SQLITE_PRAGMAS; admin settings seeded from
	// env on bootstrap.
	app := bootenv.NewApp()
	app.RootCmd.Version = versionString()
	serve := addCommands(app)
	sub, _, _ := app.RootCmd.Find(os.Args[1:])
	serving := sub == serve

	bootenv.Register(app)

	// [D-183] Snapshot pb_data before a boot that migrates or re-seeds it.
	upgradebackup.Register(app, serving)

	// The server's environment is read here, only for a serve invocation
	// ([D-63]), so a bad value kills the process first while other subcommands
	// run without it and print none of its lines.
	if serving {
		env, err := resolveServeEnv()
		if err != nil {
			log.Fatal(err)
		}
		// §10: serve defaults to `--origins=*`; default it to the app's origin
		// instead. Replace leaves the flag unchanged, so an explicit --origins
		// still replaces the default rather than adding to it.
		if env.wacfg.RPOrigin != "" {
			origins := serve.PersistentFlags().Lookup("origins").Value.(pflag.SliceValue)
			if err := origins.Replace([]string{env.wacfg.RPOrigin}); err != nil {
				log.Fatal(err)
			}
		}
	}

	// The routes (registerRoutes), then, once PocketBase listens, the seed,
	// crons and domain hooks, on every serve (apis.Serve runs
	// RunAllMigrations before OnServe).
	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Id: "shoppinglist_serve",
		Func: func(e *core.ServeEvent) error {
			env, err := resolveServeEnv()
			if err != nil {
				return err
			}
			// The default InstallerFunc is set before hooks run, so
			// the wrap reliably sees it.
			e.InstallerFunc = installerFunc(e.InstallerFunc, env)
			registerRoutes(e.Router, env)
			if err := e.Next(); err != nil {
				return err
			}
			// A failed seed fails the boot: lists made without the templates
			// would have no aisles for good, and /api/seed-version would
			// promise reference rows the database does not hold. Its one
			// transaction leaves nothing half done, so a restart retries it.
			if err := seed.Run(e.App); err != nil {
				return fmt.Errorf("seed: %w", err)
			}
			// §5.9 [D-76]: make the accounts collection's OAuth2 config
			// match SHOPPINGLIST_OIDC once migrations have created it. Invalid
			// env fails the boot ([D-61]).
			if err := oidc.Apply(e.App, env.oidc); err != nil {
				return err
			}
			// [D-241] The first account on an invite-only instance.
			if env.wacfg.Enabled {
				if err := logSetupLink(e.App, env); err != nil {
					return err
				}
			}
			// A demo instance's accounts have no login by design ([D-234]).
			if !demoBuild {
				if err := oidc.WarnStrandedAccounts(e.App, env.wacfg.Enabled, env.oidc != nil); err != nil {
					applog.Error(e.App, "stranded-account check failed", err)
				}
			}
			if err := jobs.Register(e.App); err != nil {
				applog.Error(e.App, "cron registration failed", err)
			}
			// A container with no route out fails every scan quietly; say so at
			// boot, in the background so the start never waits on the network.
			if env.scanner {
				go barcode.WarnIfUnreachable(e.App)
			}
			// [D-234] Request logging off and the expiry sweep. A failure fails
			// the boot: a demo must not keep logs or accounts.
			if err := registerDemoJobs(e.App); err != nil {
				return err
			}
			registerDomainHooks(e.App, env)
			// Last, where PocketBase prints its start banner, which is off with
			// the dashboard (startBanner).
			if !env.adminUI {
				log.Printf("shoppinglist: started at %s", env.wacfg.RPOrigin)
			}
			return nil
		},
	})

	if err := app.Execute(); err != nil {
		log.Fatal(err)
	}
}

// addCommands adds the subcommands, PocketBase's serve and superuser among
// them (what app.Start would add), and returns serve: main tells a serve
// invocation by cobra's own reading of argv, and defaults its flags.
func addCommands(app *pocketbase.PocketBase) *cobra.Command {
	serve := cmd.NewServeCommand(app, startBanner())
	app.RootCmd.AddCommand(serve, cmd.NewSuperuserCommand(app),
		// §6.13 operator content-curation tooling: a CLI subcommand, not an
		// HTTP route, since only the operator calls it.
		curate.NewCommand(app),
		// Only so `--help` lists it; main() short-circuits on argv above.
		health.NewCommand())
	return serve
}

// registerRoutes mounts the custom HTTP routes, in dependency order, as the
// serve environment configures them. security.Register reads the CSP out of
// the embedded index.html, hence publicFS (§10).
func registerRoutes(r *router.Router[*core.RequestEvent], env *serveEnv) {
	// Headers first: the lockdown returns its 404 without e.Next(), so in the
	// other order its 404 would lack the §10 headers.
	security.Register(r, publicFS, env.scanner)
	if !env.adminUI {
		security.RegisterAdminLockdown(r)
	}
	// The failure logs wrap PocketBase's own routes too, so they sit on the
	// root router; every app route goes on the app group.
	r.Bind(applog.ServerErrors())
	r.BindFunc(oidc.LogOAuth2Failure)
	app := security.AppRoutes(r)
	if env.scanner {
		barcode.SetUserAgent(version, env.shell.SourceURL)
		barcode.RegisterRoutes(app)
	} else {
		barcode.RegisterPhotoRoute(app)
	}
	if env.wacfg.Enabled {
		webauthn.RegisterRoutes(app, env.wa, env.signup)
	}
	lists.RegisterRoutes(app, env.caps)
	invites.RegisterRoutes(app)
	account.RegisterRoutes(app, account.Options{Passkeys: env.wacfg.Enabled})
	oidc.RegisterRoutes(app, oidc.Passkeys{Enabled: env.wacfg.Enabled,
		Signup: env.signup.AnyoneMaySignUp(), SignupByLink: env.signup.LinksAdmit()})
	sync.RegisterRoutes(app, env.caps)
	seed.RegisterRoutes(app)
	clienterrors.RegisterRoutes(app)
	registerDemoRoutes(app, env.demo)
	// The SPA, its shell carrying ui.Index's stamps. The mux picks the most
	// specific pattern, so every route above wins over this one, and an API
	// path none of them serves is a 404, not the shell.
	r.GET("/api/{path...}", func(e *core.RequestEvent) error { return e.NotFoundError("", nil) })
	// Out of the request log like apis.Static's files, the stamped shell too
	// ([D-271]); a failure is still logged.
	r.GET("/{path...}", ui.Static(publicFS, ui.Index(publicFS, env.shell))).Bind(apis.SkipSuccessActivityLog())
}

// registerDomainHooks binds the record hooks every serve runs.
func registerDomainHooks(app core.App, env *serveEnv) {
	// [D-08] the list rename's cap, §7.3 the last-one-out cascade.
	lists.Register(app)
	// §8.5: every write to a synced row moves its `updated`.
	sync.Register(app)
	// [D-266] an item's photo follows its barcode.
	barcode.Register(app)
	// §11 accounts self-update allowlist, §5.4 last-credential guard.
	account.Register(app, account.Options{Passkeys: env.wacfg.Enabled})
	// §5.9 [D-76]: OIDC first-login creation, at system level because
	// accounts.CreateRule stays superuser-only.
	oidc.Register(app)
	// The half of the admin lockdown that keys off collection identity
	// rather than URL spelling (see internal/security/admin.go).
	if !env.adminUI {
		security.RegisterSuperuserAuthGuard(app)
	}
}

// startBanner is whether serve prints PocketBase's start banner, which names
// the dashboard at /_/: not when SHOPPINGLIST_ADMIN_UI=off has removed it. A
// bad setting shows it, as resolveServeEnv fails the boot anyway.
func startBanner() bool {
	s, err := settings.ReadServe()
	return bool(s.AdminUI) || err != nil
}

// installerFunc wraps PocketBase's first-boot superuser installer callback so
// it prints the deployment's origin rather than the bind address (0.0.0.0 in
// the container). With the dashboard off there is none: its link would be a
// 404, and PocketBase would still mint the installer's own superuser. A nil
// inner stays nil.
func installerFunc(
	inner func(app core.App, systemSuperuser *core.Record, baseURL string) error,
	env *serveEnv,
) func(app core.App, systemSuperuser *core.Record, baseURL string) error {
	if inner == nil || !env.adminUI {
		return nil
	}
	return func(app core.App, systemSuperuser *core.Record, _ string) error {
		return inner(app, systemSuperuser, env.wacfg.RPOrigin)
	}
}
