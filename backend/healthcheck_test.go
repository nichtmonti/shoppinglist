package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// runMainEnv makes the test binary run main() instead of the tests, so a test
// can start the real entrypoint as a child process with its own argv and
// working directory.
const runMainEnv = "RUN_MAIN_FOR_TEST"

func TestMain(m *testing.M) {
	if os.Getenv(runMainEnv) == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runMain starts main() in a child process inside dir, with os.Args[0] in dir
// too, so PocketBase's default data directory (next to the binary, or the
// working directory for a binary under the temp dir) is dir/pb_data.
func runMain(t *testing.T, dir string, args ...string) (exitCode int, output string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := &exec.Cmd{
		Path: self,
		Args: append([]string{filepath.Join(dir, "shoppinglist")}, args...),
		Dir:  dir,
		Env:  append(os.Environ(), runMainEnv+"=1"),
	}
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0, string(out)
	case errors.As(err, &exit):
		return exit.ExitCode(), string(out)
	default:
		t.Fatalf("run main: %v", err)
		return 0, ""
	}
}

// [D-62]: `shoppinglist healthcheck` runs every 30 seconds beside the live
// server, so main.go handles it before anything bootstraps the app: it
// answers from the probe alone and never creates or opens a database.
func TestHealthcheckNeverOpensTheDatabase(t *testing.T) {
	var unhealthy atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" || unhealthy.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"code":200}`))
	}))
	t.Cleanup(srv.Close)
	addr := strings.TrimPrefix(srv.URL, "http://")
	dir := t.TempDir()

	if code, out := runMain(t, dir, "healthcheck", "--addr", addr); code != 0 {
		t.Fatalf("healthcheck against a healthy server exited %d: %s", code, out)
	}
	unhealthy.Store(true)
	if code, out := runMain(t, dir, "healthcheck", "--addr", addr); code != 1 || !strings.Contains(out, "unhealthy status 503") {
		t.Errorf("healthcheck against an unhealthy server exited %d: %s", code, out)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		t.Errorf("healthcheck left %s in its working directory: it bootstrapped the app", e.Name())
	}
}
