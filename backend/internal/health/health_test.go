package health

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func addrOf(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	host := strings.TrimPrefix(srv.URL, "http://")
	if _, _, err := net.SplitHostPort(host); err != nil {
		t.Fatalf("unexpected test server URL %q: %v", srv.URL, err)
	}
	return host
}

func TestProbeHealthy(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":200,"message":"API is healthy."}`))
	}))
	defer srv.Close()

	if err := Probe(addrOf(t, srv), time.Second); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	// The probe must hit PocketBase's real health route, not just any 200.
	if gotPath != "/api/health" {
		t.Errorf("probed %q, want /api/health", gotPath)
	}
}

// A timeout of 0 is no deadline, as it was when the probe used
// http.Client.Timeout: an operator's `--timeout 0` must not fail at once.
func TestProbeWithoutTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := Probe(addrOf(t, srv), 0); err != nil {
		t.Fatalf("Probe with no timeout: %v", err)
	}
}

func TestProbeUnhealthyStatus(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusNotFound, http.StatusServiceUnavailable} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		err := Probe(addrOf(t, srv), time.Second)
		srv.Close()

		if err == nil {
			t.Errorf("status %d: Probe returned nil, want error", status)
			continue
		}
		if !strings.Contains(err.Error(), "unhealthy status") {
			t.Errorf("status %d: error %q does not name the status", status, err)
		}
	}
}

// A refused connection is the case that actually fires in a container: the
// server has died or has not finished binding yet.
func TestProbeConnectionRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	addr := addrOf(t, srv)
	srv.Close() // nothing is listening on addr any more

	if err := Probe(addr, time.Second); err == nil {
		t.Fatal("Probe returned nil against a closed port, want error")
	}
}

func TestProbeTimesOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release // hang until the probe has given up
	}))
	defer func() { close(release); srv.Close() }()

	start := time.Now()
	err := Probe(addrOf(t, srv), 100*time.Millisecond)
	if err == nil {
		t.Fatal("Probe returned nil against a hanging server, want error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Probe took %v to honour a 100ms timeout", elapsed)
	}
}

// The command is executed standalone by main.go, so its wiring — flag names,
// exit-relevant error propagation — is worth a test of its own.
func TestCommandProbesAddrFlag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cmd := NewCommand()
	cmd.SetArgs([]string{"--addr", addrOf(t, srv)})
	cmd.SetOut(&strings.Builder{})
	cmd.SetErr(&strings.Builder{})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if cmd.Use != CommandName {
		t.Errorf("cmd.Use = %q, want %q — main.go short-circuits on CommandName", cmd.Use, CommandName)
	}
}

func TestCommandFailsWhenUnhealthy(t *testing.T) {
	cmd := NewCommand()
	// Port 1 on loopback: reliably nothing listening, no DNS involved.
	cmd.SetArgs([]string{"--addr", "127.0.0.1:1", "--timeout", "500ms"})
	cmd.SetOut(&strings.Builder{})
	cmd.SetErr(&strings.Builder{})

	if err := cmd.Execute(); err == nil {
		t.Fatal("Execute returned nil against a dead port; the container would be reported healthy")
	}
}
