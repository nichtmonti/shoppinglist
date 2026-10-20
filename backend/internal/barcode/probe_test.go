package barcode

import (
	"bytes"
	"errors"
	"net/http"
	"strings"
	"testing"

	"shoppinglist/internal/testutil"
)

// A 404 is an answer: every site reachable means no warning, and each site is
// asked exactly once.
func TestUnreachableIsEmptyWhenEverySiteAnswers(t *testing.T) {
	up := newUpstream(t)
	if down := Unreachable(); len(down) != 0 {
		t.Fatalf("Unreachable() = %v, want none", down)
	}
	want := []string{offKey}
	for key := range siblingSites {
		want = append(want, key)
	}
	for _, site := range want {
		if up.siteCounts()[site] != 1 {
			t.Errorf("%s asked %d times, want once", site, up.siteCounts()[site])
		}
	}
}

// A site answering with an error status is named with that status.
func TestUnreachableNamesASiteThatAnswersWithAnError(t *testing.T) {
	up := newUpstream(t)
	up.productCode = http.StatusServiceUnavailable
	down := Unreachable()
	if len(down) != 1 || !strings.HasSuffix(down[0], "(HTTP 503)") {
		t.Fatalf("Unreachable() = %v, want only OFF with HTTP 503", down)
	}
}

// No route out names every site, OFF first, with the shared cause once and
// not the whole URL.
func TestUnreachableNamesEverySiteWithNoRouteOut(t *testing.T) {
	up := newUpstream(t)
	up.server.Close()
	down := Unreachable()
	if len(down) != 1 {
		t.Fatalf("Unreachable() = %v, want one entry for the one cause", down)
	}
	host := mustHost(t, up.server.URL)
	hosts, _, _ := strings.Cut(down[0], " (")
	if got := strings.Count(hosts, host); got != 1+len(siblingSites) {
		t.Errorf("Unreachable() = %v names %d sites, want all %d", down, got, 1+len(siblingSites))
	}
	if !strings.Contains(down[0], "connection refused") || strings.Contains(down[0], "/product/") {
		t.Errorf("entry %q: want the hosts and the cause, not the URL", down[0])
	}
}

// refusedTransport is a proxy that does not listen yet.
type refusedTransport struct{}

func (refusedTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("connection refused")
}

// stubProbeWait runs wait in place of the pause between attempts and returns
// the log.
func stubProbeWait(t *testing.T, wait func()) *bytes.Buffer {
	t.Helper()
	oldWait := probeWait
	probeWait = wait
	t.Cleanup(func() { probeWait = oldWait })
	return testutil.CaptureLog(t)
}

// The egress proxy starts beside the app and listens a few seconds later: a
// site that answers on a later attempt is no warning ([D-260]).
func TestWarnIfUnreachableWaitsForAProxyThatListensLate(t *testing.T) {
	newUpstream(t)
	listening := upstreamClient.Transport
	upstreamClient.Transport = refusedTransport{}
	waits := 0
	logged := stubProbeWait(t, func() { waits++; upstreamClient.Transport = listening })
	WarnIfUnreachable(testutil.NewApp(t))
	if waits != 1 || logged.Len() != 0 {
		t.Fatalf("waited %d times and logged %q, want one wait and no warning", waits, logged)
	}
}

// A site still down after every attempt is warned about once.
func TestWarnIfUnreachableWarnsOnceAfterTheLastAttempt(t *testing.T) {
	up := newUpstream(t)
	up.server.Close()
	waits := 0
	logged := stubProbeWait(t, func() { waits++ })
	WarnIfUnreachable(testutil.NewApp(t))
	if waits != probeAttempts-1 || strings.Count(logged.String(), "level=WARN") != 1 {
		t.Fatalf("waited %d times and logged %q, want %d waits and one warning", waits, logged, probeAttempts-1)
	}
}
