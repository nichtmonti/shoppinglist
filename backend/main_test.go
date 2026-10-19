package main

import (
	"bytes"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/signup"
)

// The wrapper must hand PocketBase's installer callback the real
// deployment origin, whatever bind address PB computed for itself.
func TestInstallerOriginFunc(t *testing.T) {
	var got string
	inner := func(app core.App, systemSuperuser *core.Record, baseURL string) error {
		got = baseURL
		return nil
	}

	wrapped := installerOriginFunc(inner, "https://list.example.com")
	if err := wrapped(nil, nil, "http://0.0.0.0:8090"); err != nil {
		t.Fatalf("wrapped: %v", err)
	}
	if got != "https://list.example.com" {
		t.Errorf("baseURL = %q, want the configured origin", got)
	}

	// The installer can be disabled (nil func) — the wrap must not invent one.
	if installerOriginFunc(nil, "https://list.example.com") != nil {
		t.Error("nil inner must stay nil")
	}
}

// What each invocation reads and prints, as cobra reads argv: serve
// validates and logs the server's environment and defaults --origins to the
// app's origin, which an explicit --origins replaces rather than adds to;
// every other subcommand runs without that environment and prints none of it.
func TestInvocations(t *testing.T) {
	if demoBuild {
		t.Skip("the normal build's environment")
	}
	t.Setenv("SHOPPINGLIST_RP_ID", "list.example")
	t.Setenv("SHOPPINGLIST_ADMIN_UI", "off") // for a boot line to look for
	const appOrigin, other, bootLine = "https://list.example", "https://other.example", "remote administration disabled"

	serves := func(t *testing.T, allowed, refused string, args ...string) {
		base, stop := startServe(t, t.TempDir(), args...)
		if got := allowedOrigin(t, base, allowed); got != allowed {
			t.Errorf("CORS for %s = %q, want it allowed", allowed, got)
		}
		if got := allowedOrigin(t, base, refused); got != "" {
			t.Errorf("CORS for %s = %q, want it refused", refused, got)
		}
		if out := stop(); !strings.Contains(out, bootLine) {
			t.Errorf("serve printed no boot lines: %s", out)
		}
	}
	t.Run("serve", func(t *testing.T) { serves(t, appOrigin, other, "serve") })
	t.Run("serve --origins", func(t *testing.T) { serves(t, other, appOrigin, "serve", "--origins", other) })
	t.Run("serve --origins=", func(t *testing.T) { serves(t, other, appOrigin, "serve", "--origins="+other) })
	t.Run("a flag's value before serve", func(t *testing.T) {
		data := filepath.Join(t.TempDir(), "elsewhere")
		serves(t, appOrigin, other, "--dir", data, "serve")
		if _, err := os.Stat(filepath.Join(data, "data.db")); err != nil {
			t.Errorf("--dir before serve: %v", err)
		}
	})

	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--help"}, "dictionary-suggestions"},
		{[]string{"--version"}, "version dev"},
		{[]string{"superuser", "upsert", "admin@example.com", "hunter2hunter2"}, "Successfully saved superuser"},
		{[]string{"--dir", "serve", "superuser", "--help"}, "upsert"},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			code, out := runMain(t, t.TempDir(), tc.args...)
			if code != 0 || !strings.Contains(out, tc.want) || strings.Contains(out, bootLine) {
				t.Errorf("exit %d, want 0 with %q and no boot lines: %s", code, tc.want, out)
			}
		})
	}

	t.Run("a bad environment stops serve alone", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "")
		if code, out := runMain(t, t.TempDir(), "--dev", "serve", "--http=127.0.0.1:1"); code != 1 || !strings.Contains(out, "SHOPPINGLIST_RP_ID") {
			t.Errorf("serve exit %d, want 1 naming SHOPPINGLIST_RP_ID: %s", code, out)
		}
		if code, out := runMain(t, t.TempDir(), "superuser", "upsert", "admin@example.com", "hunter2hunter2"); code != 0 {
			t.Errorf("superuser exit %d, want 0: %s", code, out)
		}
	})
}

// startServe runs `serve` through main() in dir, on a free port, and returns
// its base URL once it answers, and a stop that ends it and returns what it
// printed.
func startServe(t *testing.T, dir string, args ...string) (base string, stop func() string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd := &exec.Cmd{
		Path:   self,
		Args:   append([]string{filepath.Join(dir, "shoppinglist")}, append(args, "--http="+addr)...),
		Dir:    dir,
		Env:    append(os.Environ(), runMainEnv+"=1"),
		Stdout: &out,
		Stderr: &out,
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	stop = func() string {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		<-exited
		return out.String()
	}
	base = "http://" + addr
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		select {
		case err := <-exited:
			t.Fatalf("serve exited (%v): %s", err, out.String())
		default:
		}
		if res, err := http.Get(base + "/api/health"); err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return base, stop
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("serve did not answer: %s", stop())
		}
	}
}

// allowedOrigin is the Access-Control-Allow-Origin the server answers a
// request from origin with.
func allowedOrigin(t *testing.T, base, origin string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+"/api/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", origin)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.Header.Get("Access-Control-Allow-Origin")
}

func TestVersionString(t *testing.T) {
	origVersion, origCommit := version, commit
	t.Cleanup(func() { version, commit = origVersion, origCommit })

	cases := []struct {
		name            string
		version, commit string
		want            string
	}{
		{"unstamped local build", "dev", "", "dev"},
		{"stamped release", "1.2.3", "a1b2c3d4e5f6", "1.2.3 (a1b2c3d)"},
		{"short commit is not truncated further", "1.2.3", "abc", "1.2.3 (abc)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			version, commit = tc.version, tc.commit
			if got := versionString(); got != tc.want {
				t.Errorf("versionString() = %q, want %q", got, tc.want)
			}
		})
	}
}

// buildServeEnv is the one place the server's environment is validated. These
// cases are the difference between "the deploy fails at boot" and "the
// operator has an instance that is not what they think it is".
func TestBuildServeEnv(t *testing.T) {
	if demoBuild {
		t.Skip("the normal build's environment; demo_on_test.go covers the demo build's ([D-234])")
	}
	t.Run("valid environment", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		env, err := buildServeEnv()
		if err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.wacfg.RPID != "list.example.com" {
			t.Errorf("RPID = %q, want list.example.com", env.wacfg.RPID)
		}
		if env.wa == nil {
			t.Error("wa is nil — the passkey routes would have nothing to bind")
		}
		if !env.adminUI || env.wacfg.Signup != signup.Open {
			t.Errorf("defaults changed: adminUI=%v signup=%q, want true and open",
				env.adminUI, env.wacfg.Signup)
		}
	})

	// [D-76]: the login switches. setOidcOn configures a valid OIDC login.
	setOidcOn := func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_OIDC", "on")
		t.Setenv("SHOPPINGLIST_OIDC_CLIENT_ID", "c")
		t.Setenv("SHOPPINGLIST_OIDC_CLIENT_SECRET", "s")
		t.Setenv("SHOPPINGLIST_OIDC_AUTH_URL", "https://idp.example.com/auth")
		t.Setenv("SHOPPINGLIST_OIDC_TOKEN_URL", "https://idp.example.com/token")
		t.Setenv("SHOPPINGLIST_OIDC_USERINFO_URL", "https://idp.example.com/userinfo")
	}

	// [D-222] A deployment still on the old names fails rather than booting
	// with the settings it meant silently dropped.
	t.Run("an old EINKAUFSLISTE_ name is an error", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		t.Setenv("EINKAUFSLISTE_ADMIN_UI", "off")
		_, err := buildServeEnv()
		if err == nil || !strings.Contains(err.Error(), "SHOPPINGLIST_ADMIN_UI") {
			t.Fatalf("err = %v, want a refusal naming SHOPPINGLIST_ADMIN_UI", err)
		}
	})

	t.Run("neither login on is an error", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_PASSKEYS", "off")
		t.Setenv("SHOPPINGLIST_APP_URL", "https://list.example.com")
		t.Setenv("SHOPPINGLIST_OIDC", "")
		_, err := buildServeEnv()
		if err == nil || !strings.Contains(err.Error(), "no login method") {
			t.Fatalf("err = %v, want a refusal: nobody could sign in", err)
		}
	})

	t.Run("an OIDC-only instance boots without an RP-ID or a WebAuthn instance", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_PASSKEYS", "off")
		t.Setenv("SHOPPINGLIST_RP_ID", "")
		t.Setenv("SHOPPINGLIST_APP_URL", "https://list.example.com")
		setOidcOn(t)
		env, err := buildServeEnv()
		if err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.wacfg.Enabled || env.wa != nil || env.oidc == nil {
			t.Errorf("passkeys enabled=%v wa=%v oidc=%v, want off/nil/set", env.wacfg.Enabled, env.wa, env.oidc)
		}
		if env.wacfg.RPOrigin != "https://list.example.com" {
			t.Errorf("RPOrigin = %q, want the app URL (CORS and the installer URL use it)", env.wacfg.RPOrigin)
		}
	})

	t.Run("OIDC connection variables without the switch are an error", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		setOidcOn(t)
		t.Setenv("SHOPPINGLIST_OIDC", "")
		if _, err := buildServeEnv(); err == nil {
			t.Fatal("an upgrade would silently turn the OIDC login off")
		}
	})

	t.Run("missing RP_ID is an error", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "")
		if _, err := buildServeEnv(); err == nil {
			t.Fatal("buildServeEnv returned nil error with no RP_ID; serve would come up without a relying party")
		}
	})

	t.Run("an unrecognised lockdown value is an error, not a fallback", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		t.Setenv("SHOPPINGLIST_ADMIN_UI", "of")
		if _, err := buildServeEnv(); err == nil {
			t.Fatal("typo in SHOPPINGLIST_ADMIN_UI accepted; the instance would boot open and look locked down")
		}
	})

	t.Run("signup closed is carried through", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		t.Setenv("SHOPPINGLIST_SIGNUP", "closed")
		env, err := buildServeEnv()
		if err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.signup.Mode != signup.Closed {
			t.Errorf("signup = %q with SHOPPINGLIST_SIGNUP=closed", env.signup.Mode)
		}
	})

	t.Run("an items-per-list cap is carried through and stamped; unset stamps nothing", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		t.Setenv(listcap.Env, "100")
		env, err := buildServeEnv()
		if err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.caps.Items != 100 {
			t.Errorf("caps.Items = %d, want 100", env.caps.Items)
		}
		if env.shell.MaxItemsPerList == nil || *env.shell.MaxItemsPerList != 100 {
			t.Errorf("shell.MaxItemsPerList = %v, want 100 — the client would check imports against its compiled cap", env.shell.MaxItemsPerList)
		}
		t.Setenv(listcap.Env, "")
		if env, err = buildServeEnv(); err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.shell.MaxItemsPerList != nil {
			t.Errorf("shell.MaxItemsPerList = %d with the cap unset, want nothing stamped", *env.shell.MaxItemsPerList)
		}
		t.Setenv(listcap.Env, "0")
		if _, err := buildServeEnv(); err == nil {
			t.Fatalf("%s=0 accepted; no list could take an item", listcap.Env)
		}
	})

	t.Run("a lists-per-account cap is carried through, unset is 25, zero fails", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		t.Setenv(listcap.ListsEnv, "")
		env, err := buildServeEnv()
		if err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.caps.Lists != 25 {
			t.Errorf("unset: caps.Lists = %d, want 25", env.caps.Lists)
		}
		t.Setenv(listcap.ListsEnv, "40")
		if env, err = buildServeEnv(); err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.caps.Lists != 40 {
			t.Errorf("caps.Lists = %d, want 40", env.caps.Lists)
		}
		t.Setenv(listcap.ListsEnv, "0")
		if _, err := buildServeEnv(); err == nil {
			t.Fatalf("%s=0 accepted; nobody could create a list", listcap.ListsEnv)
		}
	})

	t.Run("the scanner switch: unset is on, off stamps the shell, a typo fails", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "list.example.com")
		t.Setenv("SHOPPINGLIST_SCANNER", "")
		env, err := buildServeEnv()
		if err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if !env.scanner || env.shell.ScannerOff {
			t.Errorf("unset: scanner = %v, shell.ScannerOff = %v; want on and unstamped", env.scanner, env.shell.ScannerOff)
		}
		t.Setenv("SHOPPINGLIST_SCANNER", "off")
		if env, err = buildServeEnv(); err != nil {
			t.Fatalf("buildServeEnv: %v", err)
		}
		if env.scanner || !env.shell.ScannerOff {
			t.Errorf("off: scanner = %v, shell.ScannerOff = %v; want off and stamped", env.scanner, env.shell.ScannerOff)
		}
		t.Setenv("SHOPPINGLIST_SCANNER", "false")
		if _, err := buildServeEnv(); err == nil {
			t.Fatal("SHOPPINGLIST_SCANNER=false accepted; the operator meant off and the scanner would stay on")
		}
	})
}
