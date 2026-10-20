// Package settings declares every setting an operator can make, once
// ([D-337]): its name, its default and what it does, read from the
// environment by caarlos0/env. The settings tables in
// docs/deploy-reference.md are rendered from this file by this package's test
// (`go test ./internal/settings -update` rewrites them), so the two cannot
// drift. The packages that use a setting get its value and keep the checks
// that need more than one setting or say why a value cannot work.
//
// A field's doc comment is its description in the table; a last paragraph
// `Default: …` is the table's default where it is not the plain envDefault (a
// condition, a placeholder). `unit` names what a number counts, for its error.
// A field without envDefault is "unset" when blank, for the settings whose
// absence means something of its own.
package settings

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"

	"github.com/caarlos0/env/v11"
)

// Serve is read for `serve` alone, so a bad value stops the server while the
// other commands still run ([D-63]).
type Serve struct {
	// The bare domain the app is served on, e.g. `list.example.com`: no scheme,
	// port or path, and not an IP. [Effectively permanent.](#getting-rp-id-and-rp-origin-right)
	//
	// Default: *required with passkeys*
	RPID string `env:"SHOPPINGLIST_RP_ID"`
	// The exact origin in the address bar, scheme and non-default port
	// included. Set it only when that is not `https://` + the RP-ID.
	//
	// Default: `https://<RP_ID>`
	RPOrigin string `env:"SHOPPINGLIST_RP_ORIGIN"`
	// `closed` refuses new passkey accounts; `invite` admits them only through
	// an invite link. [Details](#restricting-who-can-sign-up).
	//
	// Default: `open` (`.env.example`: `invite`)
	Signup string `env:"SHOPPINGLIST_SIGNUP" envDefault:"open"`
	// `off` turns passkey login off; needs `SHOPPINGLIST_OIDC=on`.
	// [Details](#choosing-the-login-methods).
	Passkeys OnOff `env:"SHOPPINGLIST_PASSKEYS" envDefault:"on"`
	// `on` turns sign-in through your OpenID Connect provider on.
	// [Details](#oidc-login). Unset while the connection below is set stops
	// the start, so a configured login is not switched off by omission.
	//
	// Default: `off`
	OIDC *OnOff `env:"SHOPPINGLIST_OIDC"`
	// The provider connection: `SHOPPINGLIST_OIDC_CLIENT_ID`,
	// `SHOPPINGLIST_OIDC_CLIENT_SECRET`, `SHOPPINGLIST_OIDC_ISSUER`, optional
	// `SHOPPINGLIST_OIDC_NAME`; for a provider without discovery,
	// `SHOPPINGLIST_OIDC_AUTH_URL`, `SHOPPINGLIST_OIDC_TOKEN_URL` and
	// `SHOPPINGLIST_OIDC_USERINFO_URL` instead of the issuer. [Details](#oidc-login).
	OIDCConnection OIDCConnection `doc:"SHOPPINGLIST_OIDC_*"`
	// `off` removes the `/_/` dashboard and every superuser login over HTTP.
	// [Details](#turning-off-remote-administration).
	AdminUI OnOff `env:"SHOPPINGLIST_ADMIN_UI" envDefault:"on"`
	// `off` removes the barcode scanner and its camera permission; the server
	// then never contacts Open Food Facts. Photos already stored keep showing.
	Scanner OnOff `env:"SHOPPINGLIST_SCANNER" envDefault:"on"`
	// Most items one list holds, bought and removed ones included. Below
	// `2000` it also caps one import. Lowering it deletes nothing.
	MaxItemsPerList Positive `env:"SHOPPINGLIST_MAX_ITEMS_PER_LIST" envDefault:"5000" unit:"items per list"`
	// Most lists one account can be on, its own and joined ones. Joining is
	// never refused. Lowering it removes no one.
	MaxListsPerAccount Positive `env:"SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT" envDefault:"25" unit:"lists per account"`
	// Where the settings screen's "Source code" link points. Running a
	// **modified** version, the AGPL-3.0 requires pointing it at your source.
	// The barcode lookup names it to Open Food Facts too, in its User-Agent.
	//
	// Default: this repository
	SourceURL string `env:"SHOPPINGLIST_SOURCE_URL"`
}

// OIDCConnection is how the server reaches the OpenID Connect provider; one
// row in the table.
type OIDCConnection struct {
	ClientID     string `env:"SHOPPINGLIST_OIDC_CLIENT_ID"`
	ClientSecret string `env:"SHOPPINGLIST_OIDC_CLIENT_SECRET"`
	Issuer       string `env:"SHOPPINGLIST_OIDC_ISSUER"`
	Name         string `env:"SHOPPINGLIST_OIDC_NAME"`
	AuthURL      string `env:"SHOPPINGLIST_OIDC_AUTH_URL"`
	TokenURL     string `env:"SHOPPINGLIST_OIDC_TOKEN_URL"`
	UserinfoURL  string `env:"SHOPPINGLIST_OIDC_USERINFO_URL"`
}

// Boot is read for every command, when the app is created: PocketBase's own
// configuration ([D-65]). SQLITE_PRAGMAS is unprefixed: it names the SQLite
// driver's own connection options.
type Boot struct {
	// PocketBase's "app URL". With passkeys off, the app's origin when
	// `SHOPPINGLIST_RP_ORIGIN` is unset.
	//
	// Default: `http://localhost:8090`
	AppURL string `env:"SHOPPINGLIST_APP_URL"`
	// The header your reverse proxy puts the client IP in, usually
	// `X-Forwarded-For`. Without it every user shares one rate limit. Unset
	// keeps a header an earlier start stored (the log warns); clear it in the
	// dashboard. [Details](#1-send-the-app-the-real-client-ip).
	//
	// Default: *unset* (`.env.example`: `X-Forwarded-For`)
	TrustedProxyHeader string `env:"SHOPPINGLIST_TRUSTED_PROXY_HEADER"`
	// `on` reads the header's leftmost value. Only for a
	// [proxy chain](#only-if-you-run-a-proxy-chain) whose every hop overwrites
	// the header.
	//
	// Default: `off`
	TrustedProxyLeftmost *OnOff `env:"SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST"`
	// Only for a data directory on NFS or virtiofs.
	// [Details](#sqlite-on-network-storage).
	//
	// Default: *stock*
	SQLitePragmas string `env:"SQLITE_PRAGMAS"`
}

// Demo is read by the demo build alone ([D-234]).
type Demo struct {
	// How many demos one address may start per 10 minutes. Set `3` for a
	// public demo.
	//
	// Default: `1000` in the image, `3` without it
	StartsPerIP Positive `env:"SHOPPINGLIST_DEMO_STARTS_PER_IP" envDefault:"3" unit:"demo starts per address per 10 minutes"` // [D-235]: the :demo image raises it, every start on a visitor's own machine coming from one address
	// How many demo accounts may exist at once; a start beyond it is refused
	// until old ones expire.
	MaxAccounts Positive `env:"SHOPPINGLIST_DEMO_MAX_ACCOUNTS" envDefault:"200" unit:"demo accounts"` // far above a day of real visitors, far below what fills a small disk
}

// Each setting's name, for the messages that name it. A struct tag cannot
// refer to a constant, so each is written twice, side by side;
// TestConstantsAreTheTags keeps the two the same.
const (
	RPIDEnv                 = "SHOPPINGLIST_RP_ID"
	RPOriginEnv             = "SHOPPINGLIST_RP_ORIGIN"
	SignupEnv               = "SHOPPINGLIST_SIGNUP"
	PasskeysEnv             = "SHOPPINGLIST_PASSKEYS"
	OIDCEnv                 = "SHOPPINGLIST_OIDC"
	OIDCClientIDEnv         = "SHOPPINGLIST_OIDC_CLIENT_ID"
	OIDCClientSecretEnv     = "SHOPPINGLIST_OIDC_CLIENT_SECRET"
	OIDCIssuerEnv           = "SHOPPINGLIST_OIDC_ISSUER"
	OIDCNameEnv             = "SHOPPINGLIST_OIDC_NAME"
	OIDCAuthURLEnv          = "SHOPPINGLIST_OIDC_AUTH_URL"
	OIDCTokenURLEnv         = "SHOPPINGLIST_OIDC_TOKEN_URL"
	OIDCUserinfoURLEnv      = "SHOPPINGLIST_OIDC_USERINFO_URL"
	AdminUIEnv              = "SHOPPINGLIST_ADMIN_UI"
	ScannerEnv              = "SHOPPINGLIST_SCANNER"
	MaxItemsPerListEnv      = "SHOPPINGLIST_MAX_ITEMS_PER_LIST"
	MaxListsPerAccountEnv   = "SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT"
	SourceURLEnv            = "SHOPPINGLIST_SOURCE_URL"
	AppURLEnv               = "SHOPPINGLIST_APP_URL"
	TrustedProxyHeaderEnv   = "SHOPPINGLIST_TRUSTED_PROXY_HEADER"
	TrustedProxyLeftmostEnv = "SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST"
	SQLitePragmasEnv        = "SQLITE_PRAGMAS"
	DemoStartsPerIPEnv      = "SHOPPINGLIST_DEMO_STARTS_PER_IP"
	DemoMaxAccountsEnv      = "SHOPPINGLIST_DEMO_MAX_ACCOUNTS"
)

// Others are the SHOPPINGLIST_ names the server sees but reads nothing from,
// so the start's unknown-name check passes them ([D-336]).
var Others = []string{
	// docker-compose.yml's own, handed over with the rest of .env.
	"SHOPPINGLIST_BIND",
	"SHOPPINGLIST_VERSION",
	// Not settings: the repo's tooling sets them around the servers it starts
	// (the devcontainer, the gate, the harnesses, the builds).
	"SHOPPINGLIST_BIN",
	"SHOPPINGLIST_DEMO_BIN",
	"SHOPPINGLIST_DEMO_BUILD",
	"SHOPPINGLIST_DEV_INSTANCE",
	"SHOPPINGLIST_DEVCONTAINER",
	"SHOPPINGLIST_TPL_OUT",
}

// OnOff is a switch written `on` or `off`, case ignored.
type OnOff bool

// UnmarshalText implements encoding.TextUnmarshaler for caarlos0/env.
func (o *OnOff) UnmarshalText(b []byte) error {
	switch v := strings.ToLower(string(b)); v {
	case "on":
		*o = true
	case "off":
		*o = false
	default:
		return fmt.Errorf("(%q) must be \"on\" or \"off\"", v)
	}
	return nil
}

// On reports the switch. A switch whose absence means something of its own is
// a *OnOff field, nil while unset, and unset reads as off; the table's test
// holds its documented default to `off`.
func (o *OnOff) On() bool { return o != nil && bool(*o) }

// Positive is a whole number of at least 1.
type Positive int

// UnmarshalText implements encoding.TextUnmarshaler for caarlos0/env.
func (p *Positive) UnmarshalText(b []byte) error {
	n, err := strconv.Atoi(string(b))
	if err != nil || n < 1 {
		return fmt.Errorf("(%q) must be a whole number >= 1", b)
	}
	*p = Positive(n)
	return nil
}

// ReadServe reads the settings only `serve` uses.
func ReadServe() (Serve, error) { return read[Serve](environ()) }

// ReadBoot reads the settings every command uses.
func ReadBoot() (Boot, error) { return read[Boot](environ()) }

// ReadDemo reads the demo build's settings.
func ReadDemo() (Demo, error) { return read[Demo](environ()) }

// ServeDefaults is Serve with nothing set.
func ServeDefaults() Serve { return defaults[Serve]() }

// DemoDefaults is Demo with nothing set.
func DemoDefaults() Demo { return defaults[Demo]() }

func defaults[T any]() T {
	s, err := read[T](map[string]string{})
	if err != nil {
		panic(fmt.Sprintf("settings: a default does not parse: %v", err))
	}
	return s
}

// Names is every setting's name, the demo build's included.
func Names() []string {
	var names []string
	for _, v := range []any{&Serve{}, &Boot{}, &Demo{}} {
		params, err := env.GetFieldParams(v)
		if err != nil {
			panic(fmt.Sprintf("settings: %v", err))
		}
		for _, p := range params {
			names = append(names, p.Key)
		}
	}
	return names
}

// environ is the process environment with every value trimmed: blank is
// unset, as compose passes "not configured" ([D-61]), and caarlos0/env applies
// a default only to an empty value.
func environ() map[string]string {
	m := map[string]string{}
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if v = strings.TrimSpace(v); v != "" {
			m[k] = v
		}
	}
	return m
}

// read parses T from vars, every refusal naming its variable ([D-61]), all of
// them at once.
func read[T any](vars map[string]string) (T, error) {
	var s T
	err := env.ParseWithOptions(&s, env.Options{Environment: vars})
	var agg env.AggregateError
	if err == nil || !errors.As(err, &agg) {
		return s, err
	}
	msgs := make([]string, 0, len(agg.Errors))
	for _, e := range agg.Errors {
		var pe env.ParseError
		if !errors.As(e, &pe) {
			msgs = append(msgs, e.Error())
			continue
		}
		f := field(reflect.TypeOf(s), pe.Name)
		msg := f.Tag.Get("env") + " " + pe.Err.Error()
		if unit := f.Tag.Get("unit"); unit != "" {
			msg += " (" + unit + ")"
		}
		msgs = append(msgs, msg)
	}
	return s, errors.New(strings.Join(msgs, "; "))
}

// field finds a field by name in t or a struct it holds.
func field(t reflect.Type, name string) reflect.StructField {
	if f, ok := t.FieldByName(name); ok {
		return f
	}
	for field := range t.Fields() {
		if sub := field.Type; sub.Kind() == reflect.Struct {
			if f, ok := sub.FieldByName(name); ok {
				return f
			}
		}
	}
	return reflect.StructField{}
}
