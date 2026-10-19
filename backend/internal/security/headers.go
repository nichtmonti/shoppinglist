// The §10 response headers, Content-Security-Policy included.

package security

import (
	"io/fs"
	"regexp"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// baselineCSP is the policy served when no built index.html is available to
// read a full policy from (dev, tests, an unbuilt tree), and under
// PocketBase's own dashboard.
const baselineCSP = "frame-ancestors 'none'"

// permissionsPolicy is the §10 permission enumeration, stated so that adding
// to it is a one-line review. camera (the scanner) and
// publickey-credentials-get (passkey login breaks without it) are the only
// real allowances; permissionsPolicyFor denies the camera when the scanner is
// off ([D-218]).
const permissionsPolicy = "camera=(self), publickey-credentials-get=(self), fullscreen=(self), " +
	"accelerometer=(), autoplay=(), display-capture=(), encrypted-media=(), geolocation=(), " +
	"gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), screen-wake-lock=(), " +
	"usb=(), xr-spatial-tracking=()"

// permissionsPolicyFor is the policy with the camera allowed or denied.
func permissionsPolicyFor(camera bool) string {
	if camera {
		return permissionsPolicy
	}
	return strings.Replace(permissionsPolicy, "camera=(self)", "camera=()", 1)
}

// SvelteKit's meta CSP is always double-quoted and escapes only `&` and `"`,
// neither of which a CSP contains, so the capture needs no unescaping. The
// value is full of single quotes, hence the double-quote-only class.
var metaCSPPattern = regexp.MustCompile(
	`(?i)<meta\s+http-equiv="content-security-policy"\s+content="([^"]*)"`)

// Register installs the §10 headers on every response, SPA shell and custom
// routes alike, by binding on the router rather than a route group.
//
//   - Referrer-Policy: no-referrer. Invite tokens live in the URL fragment,
//     which is never sent; this covers one that lands in a query string.
//   - X-Content-Type-Options: nosniff. The auth token lives in IndexedDB
//     (§5.6), so any script execution on this origin is a full account
//     compromise.
//   - X-Frame-Options: DENY, against clickjacking the destructive one-tap
//     controls.
//   - Cross-Origin-Opener-Policy: same-origin. Safe with OAuth2 ([D-76]): its
//     popup handshake rides the realtime SSE topic, not window.opener; but
//     nothing may poll `popup.closed`, which then reads true mid-sign-in
//     ([D-155]). COEP is not set: every subresource is same-origin, so it
//     would enforce nothing the CSP does not.
//   - Strict-Transport-Security is NOT set: it belongs in the TLS proxy.
//
// The Content-Security-Policy is mirrored, not composed: frontend/
// vite.config.ts's `csp` block is its single source, emitted as a meta tag in
// index.html with the hash of the inline bootstrap script. A browser enforces
// meta and header policies independently, so a hand-written header would block
// that script, only in production; e2e/tests/csp.spec.ts asserts they agree.
// The header adds `frame-ancestors 'none'` (which a meta CSP cannot express)
// and covers non-document responses the meta tag cannot.
//
// camera is false when the scanner is off ([D-218]).
func Register(r *router.Router[*core.RequestEvent], publicFS fs.FS, camera bool) {
	appCSP := loadCSP(publicFS)
	permissions := permissionsPolicyFor(camera)

	r.BindFunc(func(e *core.RequestEvent) error {
		h := e.Response.Header()
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", permissions)
		h.Set("Cross-Origin-Opener-Policy", "same-origin")

		// PocketBase's dashboard gets only the baseline CSP: a PocketBase
		// version bump must not be breakable by a policy of ours.
		if isDashboardPath(e.Request.URL.Path) {
			h.Set("Content-Security-Policy", baselineCSP)
		} else {
			h.Set("Content-Security-Policy", appCSP)
		}
		return e.Next()
	})
}

func isDashboardPath(path string) bool {
	return path == "/_" || strings.HasPrefix(path, "/_/")
}

// loadCSP extracts the policy SvelteKit baked into index.html and appends
// frame-ancestors. Any failure (a no_ui build, no meta tag) falls back to the
// baseline, so the app never boots into a policy that would break it. It reads
// an fs.FS because the SPA is embedded in the binary ([D-64]).
func loadCSP(publicFS fs.FS) string {
	if publicFS == nil {
		return baselineCSP
	}
	html, err := fs.ReadFile(publicFS, "index.html")
	if err != nil {
		return baselineCSP
	}
	m := metaCSPPattern.FindSubmatch(html)
	if m == nil {
		return baselineCSP
	}
	policy := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(string(m[1])), ";"))
	if policy == "" {
		return baselineCSP
	}
	return policy + "; " + baselineCSP
}
