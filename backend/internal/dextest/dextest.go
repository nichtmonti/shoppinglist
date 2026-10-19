// Package dextest runs Dex — the pinned OpenID Connect provider in tools/dex
// ([D-154]) — for tests that need a real issuer: it writes a config with
// in-memory storage and static password users, starts the binary on a free
// loopback port, and drives Dex's own login form the way a browser would.
//
// This is the "binary in CI" arrangement Docker's guide to mocking OAuth with
// Dex describes, rather than Testcontainers' Dex module: the devcontainer and
// the CI Go step have no Docker, and the same binary also serves the
// Playwright OIDC harness (e2e/oidc) and manual runs.
//
// The binary is `$DEX_BIN` when set, else built from the tools/dex pin on
// first use — never a `dex` found on PATH, whose version nothing pins.
package dextest

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// Password is every static user's password.
const Password = "password"

// passwordHash is bcrypt("password"), the example hash Dex's own docs use.
const passwordHash = "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W" // #nosec G101 -- the test Dex's fixture user; never linked (deps_arch_test.go)

// The client Dex registers for the app under test.
const (
	ClientID     = "shoppinglist"
	ClientSecret = "shoppinglist-secret" // #nosec G101 -- the test Dex's fixture client; never linked (deps_arch_test.go)
)

// User is one static password user. ID becomes the user's Dex userID, from
// which Dex derives the `sub` claim; Name is the `name` claim.
type User struct {
	Email string
	Name  string
	ID    string
}

// Dex is one running provider.
type Dex struct {
	// Issuer is the provider's base URL; its endpoints hang off it.
	Issuer string
}

// Start runs Dex for the test's lifetime with `users` as its static password
// users and one client allowed to return to `redirectURI`.
func Start(t *testing.T, redirectURI string, users ...User) *Dex {
	t.Helper()
	bin := binary(t)

	port, err := freePort()
	if err != nil {
		t.Fatalf("dextest: free port: %v", err)
	}
	issuer := fmt.Sprintf("http://127.0.0.1:%d/dex", port)
	dir := t.TempDir()
	cfg := filepath.Join(dir, "dex.yaml")
	if err := os.WriteFile(cfg, []byte(Config(issuer, redirectURI, users...)), 0o600); err != nil {
		t.Fatalf("dextest: write config: %v", err)
	}

	var logs bytes.Buffer
	// #nosec G204 -- the pinned Dex build (or $DEX_BIN) on a config this package wrote.
	cmd := exec.Command(bin, "serve", cfg)
	cmd.Stdout, cmd.Stderr = &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("dextest: start %s: %v", bin, err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("dex output:\n%s", logs.String())
		}
	})

	if err := waitReady(issuer + "/.well-known/openid-configuration"); err != nil {
		t.Fatalf("dextest: %v\ndex output:\n%s", err, logs.String())
	}
	return &Dex{Issuer: issuer}
}

// Config renders a Dex config: in-memory storage, the approval screen
// skipped (a real consent screen is the provider's business, not the app's),
// one client for `redirectURI`, and `users` in Dex's password database. The
// Playwright harness renders the same shape (e2e/oidc/oidc.config.ts); keep
// the two in step.
func Config(issuer, redirectURI string, users ...User) string {
	u, _ := url.Parse(issuer)
	var b strings.Builder
	fmt.Fprintf(&b, "issuer: %s\nstorage:\n  type: memory\nweb:\n  http: %s\n", issuer, u.Host)
	b.WriteString("oauth2:\n  skipApprovalScreen: true\nenablePasswordDB: true\n")
	fmt.Fprintf(&b, "staticClients:\n  - id: %s\n    secret: %s\n    name: Einkaufsliste\n    redirectURIs: [%q]\n",
		ClientID, ClientSecret, redirectURI)
	b.WriteString("staticPasswords:\n")
	for _, usr := range users {
		fmt.Fprintf(&b, "  - email: %q\n    hash: %q\n    username: %q\n    userID: %q\n",
			usr.Email, passwordHash, usr.Name, usr.ID)
	}
	return b.String()
}

var formAction = regexp.MustCompile(`<form method="post" action="([^"]+)"`)

// Login signs `email` in through Dex's login form, starting from `authURL`
// (the provider authorization URL the app handed the browser, redirect_uri
// included), and returns the URL Dex redirects back to — carrying the code.
// Nothing past Dex is requested: the app's redirect handler is the caller's.
func (d *Dex) Login(authURL, email string) (*url.URL, error) {
	jar, _ := cookiejar.New(nil)
	issuer, _ := url.Parse(d.Issuer)
	client := &http.Client{
		Jar: jar,
		// Follow Dex's own hops (auth → auth/local → the login form); stop
		// at the first one that leaves Dex, which is the app's redirect URI.
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			if req.URL.Host != issuer.Host {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	res, err := client.Get(authURL)
	if err != nil {
		return nil, fmt.Errorf("authorize: %w", err)
	}
	page, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	m := formAction.FindSubmatch(page)
	if m == nil {
		return nil, fmt.Errorf("no login form at %s (status %d)", res.Request.URL, res.StatusCode)
	}
	action, err := res.Request.URL.Parse(html.UnescapeString(string(m[1])))
	if err != nil {
		return nil, err
	}

	res, err = client.PostForm(action.String(), url.Values{"login": {email}, "password": {Password}})
	if err != nil {
		return nil, fmt.Errorf("login: %w", err)
	}
	_ = res.Body.Close()
	loc, err := res.Location()
	if err != nil {
		return nil, fmt.Errorf("login as %s did not redirect back (status %d)", email, res.StatusCode)
	}
	return loc, nil
}

var buildOnce = sync.OnceValues(build)

// binary returns the Dex executable: $DEX_BIN, else a build of the tools/dex
// pin. The build is keyed by the pin's go.mod + go.sum, under the user cache
// directory: built once per pin and reused by every later test process,
// rather than a 54 MB binary left in a fresh temp directory by each run.
func binary(t *testing.T) string {
	t.Helper()
	if bin := os.Getenv("DEX_BIN"); bin != "" {
		return bin
	}
	bin, err := buildOnce()
	if err != nil {
		t.Fatalf("dextest: %v", err)
	}
	return bin
}

func build() (string, error) {
	_, self, _, _ := runtime.Caller(0)
	tools := filepath.Join(filepath.Dir(self), "..", "..", "..", "tools", "dex")
	sum := sha256.New()
	for _, f := range []string{"go.mod", "go.sum"} {
		b, err := os.ReadFile(filepath.Join(tools, f)) // #nosec G304 -- this repo's own pin files
		if err != nil {
			return "", err
		}
		sum.Write(b)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	bin := filepath.Join(cache, "shoppinglist-dextest", fmt.Sprintf("dex-%x", sum.Sum(nil)[:6]))
	if _, err := os.Stat(bin); err == nil {
		return bin, nil
	}
	if err := os.MkdirAll(filepath.Dir(bin), 0o750); err != nil {
		return "", err
	}
	// Built beside its final name and renamed into place, so a concurrent test
	// process never runs a half-written binary.
	tmp := fmt.Sprintf("%s.%d", bin, os.Getpid())
	// #nosec G204 -- fixed arguments; the tools/dex path is this repo's own.
	out, err := exec.Command("go", "-C", tools, "build", "-o", tmp, "github.com/dexidp/dex/cmd/dex").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("build tools/dex: %v\n%s", err, out)
	}
	return bin, os.Rename(tmp, bin)
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func waitReady(discovery string) error {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		res, err := http.Get(discovery) // #nosec G107 -- our own loopback Dex, URL built by Start
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("dex did not come up within 15s")
}
