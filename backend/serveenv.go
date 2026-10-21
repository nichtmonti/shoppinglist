// The server's environment: everything `serve` reads and no other subcommand
// does, validated once at boot and logged where it differs from a default.
package main

import (
	"fmt"
	"log"
	// stdsync, not "sync": internal/sync owns the plain name in this package.
	stdsync "sync"

	wlib "github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/barcode"
	"shoppinglist/internal/envflag"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/oidc"
	"shoppinglist/internal/security"
	"shoppinglist/internal/settings"
	"shoppinglist/internal/signup"
	"shoppinglist/internal/ui"
	"shoppinglist/internal/webauthn"
)

// serveEnv is the configuration only the HTTP server needs, kept apart so
// other subcommands run without SHOPPINGLIST_RP_ID.
type serveEnv struct {
	wacfg *webauthn.Config
	// signup is SHOPPINGLIST_SIGNUP's gate ([D-241]).
	signup *signup.Gate
	// wa is nil while passkeys are off (SHOPPINGLIST_PASSKEYS=off, [D-76]).
	wa *wlib.WebAuthn
	// oidc is SHOPPINGLIST_OIDC's configuration, nil while it is off ([D-76]).
	oidc    *oidc.Config
	adminUI bool
	// scanner is SHOPPINGLIST_SCANNER ([D-218]).
	scanner bool
	// shell is what the SPA reads out of the shell document (ui.Shell).
	shell ui.Shell
	// caps are the [D-217] items and [D-219] lists caps.
	caps listcap.Caps
	// demo is the demo build's configuration ([D-234]); empty in a normal build.
	demo demoConfig
}

// buildServeEnv parses and logs the server's environment. It returns an error
// rather than exiting so each call site decides how to fail.
func buildServeEnv() (*serveEnv, error) {
	env, err := parseServeEnv()
	if err != nil {
		return nil, err
	}
	logServeEnv(env)
	return env, nil
}

// parseServeEnv is buildServeEnv's parsing half. Every value is validated
// here, so a typo fails the boot ([D-61]).
func parseServeEnv() (*serveEnv, error) {
	// [D-222] An old EINKAUFSLISTE_ name still set fails the boot; the [D-223]
	// settings listed were removed, not renamed.
	if err := envflag.RenamedPrefix("EINKAUFSLISTE_", "SHOPPINGLIST_",
		"RP_DISPLAY_NAME", "DEFAULT_LOCALE", "SHOPPING_DAY_START_HOUR",
		"BEGIN_RATE_LIMIT", "FINISH_RATE_LIMIT", "LIST_CREATE_RATE_LIMIT"); err != nil {
		return nil, err
	}
	// [D-336] A misspelt name would be ignored, and the lockdown it meant left off.
	// The one unprefixed setting: SQLITE_PRAGMA would leave stock WAL on the
	// network storage it is for. A blanket SQLITE_ would catch SQLite's own.
	for _, prefix := range []string{"SHOPPINGLIST_", "SQLITE_PRAGMA"} {
		if err := envflag.Unknown(prefix, append(settings.Names(), settings.Others...),
			"docs/deploy-reference.md#environment-variables"); err != nil {
			return nil, err
		}
	}
	// [D-337] Every setting, read once; a value of the wrong kind stops here,
	// all of them named at once.
	set, err := settings.ReadServe()
	if err != nil {
		return nil, err
	}
	boot, err := settings.ReadBoot()
	if err != nil {
		return nil, err
	}
	// §5.7: with passkeys on, the RP-ID is mandatory and must be a domain
	// (passkeys break otherwise). [D-76]: SHOPPINGLIST_PASSKEYS=off drops the
	// requirement along with the routes.
	wacfg, err := webauthn.FromSettings(set, boot)
	if err != nil {
		return nil, err
	}
	var wa *wlib.WebAuthn
	if wacfg.Enabled {
		if wa, err = webauthn.New(wacfg); err != nil {
			return nil, err
		}
	}
	// [D-76]: SHOPPINGLIST_OIDC, validated here; oidc.Apply writes it to the
	// accounts collection once that exists.
	oidcCfg, err := oidc.FromSettings(set)
	if err != nil {
		return nil, err
	}
	oidcOn := oidcCfg != nil
	// [D-234] The demo build signs visitors in itself, and only on an instance
	// with no other login.
	demoCfg, err := demoFromEnv(wacfg.Enabled, oidcOn)
	if err != nil {
		return nil, err
	}
	// [D-335] An instance whose address is plain http works for no visitor.
	// The demo says so on its start screen instead, so it runs at one too.
	if !demoBuild {
		if err := webauthn.SecureOrigin(wacfg.RPOrigin); err != nil {
			return nil, err
		}
	}
	if !wacfg.Enabled && !oidcOn && !demoBuild {
		return nil, fmt.Errorf("no login method: %s=off needs SHOPPINGLIST_OIDC=on, or nobody can sign in",
			webauthn.PasskeysEnv)
	}
	// §10: remote administration is a deployment choice, not a build-time one.
	adminUI, scanner := bool(set.AdminUI), bool(set.Scanner)
	// §12.2 + §6.10: what the SPA is told about this deployment.
	shell, err := ui.ShellFromSettings(set)
	if err != nil {
		return nil, err
	}
	shell.ScannerOff = !scanner
	// [D-181] The SPA is embedded, so the binary's version is the SPA's.
	shell.Version = versionString()
	caps := listcap.FromSettings(set)
	// [D-217] Only a moved cap is stamped for the client's import check.
	if caps.Items != fieldcontract.MaxItemsPerList() {
		shell.MaxItemsPerList = &caps.Items
	}
	return &serveEnv{wacfg: wacfg, signup: signup.NewGate(wacfg.Signup), wa: wa, oidc: oidcCfg, adminUI: adminUI, scanner: scanner, shell: shell,
		caps: caps, demo: demoCfg}, nil
}

// logServeEnv is buildServeEnv's logging half: one line for each non-default
// setting that changes what users or the operator can do.
func logServeEnv(env *serveEnv) {
	if line := demoLogLine(env.demo); line != "" {
		log.Print(line)
	}
	// A demo instance's own line above says how it signs in ([D-234]).
	if !env.wacfg.Enabled && !demoBuild {
		log.Printf("shoppinglist: passkeys off (%s=off) — sign-in is OIDC only", webauthn.PasskeysEnv)
	}
	// A demo instance has no administration to speak of ([D-234]).
	if !env.adminUI && !demoBuild {
		log.Printf("shoppinglist: remote administration disabled (%s=off) — "+
			"the dashboard at /_/ returns 404 and superusers cannot authenticate over HTTP; "+
			"run the `superuser` and `dictionary-suggestions` subcommands instead "+
			"(in Docker: docker compose run --rm --entrypoint /shoppinglist shoppinglist superuser upsert …)",
			security.AdminUIEnv)
	}
	if !env.scanner {
		log.Printf("shoppinglist: barcode scanner off (%s=off) — no scan button, no camera permission, "+
			"and the server never contacts Open Food Facts; photos of items scanned earlier still show",
			barcode.ScannerEnv)
	}
	switch mode := env.wacfg.Signup; {
	case mode != signup.Open && !env.wacfg.Enabled:
		log.Printf("shoppinglist: %s=%s has no effect while %s=off — "+
			"it only governs new passkey accounts; who may sign in with OIDC is the provider's business",
			signup.Env, mode, webauthn.PasskeysEnv)
	case mode == signup.Closed:
		log.Printf("shoppinglist: passkey signup closed (%s=closed) — "+
			"new passkey accounts are refused; existing accounts can still log in and add passkeys, "+
			"and a first OIDC sign-in still creates its account", signup.Env)
	case mode == signup.Invite:
		log.Printf("shoppinglist: passkey signup by invite only (%s=invite) — "+
			"a new passkey account needs a list's invite link and joins that list; "+
			"existing accounts can still log in and add passkeys, and a first OIDC sign-in still creates its account",
			signup.Env)
	}
	if env.caps.Items != fieldcontract.MaxItemsPerList() {
		log.Printf("shoppinglist: a list holds at most %d items, removed and bought ones included, "+
			"and an import brings at most %d (%s) — the default is %d",
			env.caps.Items, env.caps.ImportMax(), listcap.Env, fieldcontract.MaxItemsPerList())
	}
	if env.caps.Lists != listcap.Default().Lists {
		log.Printf("shoppinglist: an account can be on at most %d lists (%s) — the default is %d",
			env.caps.Lists, listcap.ListsEnv, listcap.Default().Lists)
	}
}

// logSetupLink prints the setup link for the first account of an invite-only
// instance ([D-241]). The token lives in memory, so every boot until that
// account exists prints a new one. Not knowing whether an account exists
// fails the boot: an invite-only instance without its link has no way in.
func logSetupLink(app core.App, env *serveEnv) error {
	token, ok, err := env.signup.StartSetup(app)
	if err != nil {
		return fmt.Errorf("setup link: %w", err)
	}
	if !ok {
		return nil
	}
	log.Printf("shoppinglist: no accounts yet and %s=invite — create the first account at %s/#setup=%s "+
		"(valid until the first account exists; every restart before then prints a new link)",
		signup.Env, env.wacfg.RPOrigin, token)
	return nil
}

// resolveServeEnv memoizes buildServeEnv so every caller agrees and the log
// lines print once.
var resolveServeEnv = stdsync.OnceValues(buildServeEnv)
