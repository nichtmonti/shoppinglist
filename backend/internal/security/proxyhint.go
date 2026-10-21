package security

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/settings"
)

// forwardingHeaders are the headers a reverse proxy commonly sets for the
// client's address and PocketBase can read: not RFC 7239's Forwarded, whose
// for= it does not parse, so naming that one would not help.
var forwardingHeaders = []string{"X-Forwarded-For", "X-Real-Ip", "Cf-Connecting-Ip"}

// ProxyHeaderHint warns once per start when a request carries a forwarding
// header while the app trusts none: behind a reverse proxy every visitor then
// has the proxy's address, and shares one rate-limit budget ([D-65]). It only
// warns: without a proxy, a client can send the header itself.
func ProxyHeaderHint() func(*core.RequestEvent) error {
	var once sync.Once
	return func(e *core.RequestEvent) error {
		if len(e.App.Settings().TrustedProxy.Headers) == 0 {
			for _, h := range forwardingHeaders {
				if e.Request.Header.Get(h) != "" {
					once.Do(func() {
						applog.Warn(e.App, "requests carry a "+h+" header, but "+settings.TrustedProxyHeaderEnv+
							" is unset, so every visitor behind a reverse proxy has its address and shares one rate limit; "+
							"if your proxy sets this header, set the variable to it", nil)
					})
					break
				}
			}
		}
		return e.Next()
	}
}
