package oidc

import (
	"context"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"strings"
	"testing"
)

// viaProxy makes every request look proxied through proxy, as HTTPS_PROXY
// does; "" means no proxy.
func viaProxy(t *testing.T, proxy string) {
	t.Helper()
	old := proxyFor
	proxyFor = func(*http.Request) (*neturl.URL, error) {
		if proxy == "" {
			return nil, nil
		}
		return neturl.Parse(proxy)
	}
	t.Cleanup(func() { proxyFor = old })
}

// An allowlisting proxy's refusal reaches net/http as its bare status line;
// the boot error has to say a proxy was in the way, and which host it needs.
func TestDiscoveryRefusedByProxyNamesIt(t *testing.T) {
	noRetryWait(t)
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden) // what Squid answers a CONNECT it denies
	}))
	t.Cleanup(squid.Close)
	viaProxy(t, "http://user:pw@"+squid.Listener.Addr().String())
	proxyURL, _ := neturl.Parse(squid.URL)
	old := discoveryClient
	discoveryClient = &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	t.Cleanup(func() { discoveryClient = old })

	_, err := discover(context.Background(), "https://idp.example.com/realms/hh")
	if err == nil {
		t.Fatal("discovery through a refusing proxy succeeded")
	}
	for _, want := range []string{"through the proxy", "HTTPS_PROXY", "allows idp.example.com"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "pw") {
		t.Errorf("error %q leaks the proxy password", err)
	}
}

func TestDiscoveryFailureWithoutProxyHasNoHint(t *testing.T) {
	noRetryWait(t)
	viaProxy(t, "")
	_, err := discover(context.Background(), "http://127.0.0.1:1/realms/hh")
	if err == nil || strings.Contains(err.Error(), "proxy") {
		t.Errorf("error = %v, want a failure that mentions no proxy", err)
	}
}
