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
// read a full policy from (dev, tests, an unbuilt tree).
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
// The header adds `frame-ancestors 'none'` (which a meta CSP cannot express),
// against clickjacking the destructive one-tap controls, and covers
// non-document responses the meta tag cannot.
//
// PocketBase sets its own policy where none is set yet: a full one for its
// dashboard, and a sandbox for the files it serves (/api/files, and the
// product photos through the same Serve). Those keep theirs.
//
// camera is false when the scanner is off ([D-218]).
func Register(r *router.Router[*core.RequestEvent], publicFS fs.FS, camera bool) {
	appCSP := loadCSP(publicFS)
	permissions := permissionsPolicyFor(camera)

	r.BindFunc(func(e *core.RequestEvent) error {
		h := e.Response.Header()
		// PocketBase's default middleware already sends nosniff,
		// Cross-Origin-Opener-Policy: same-origin and X-Frame-Options, which
		// the CSP's frame-ancestors overrides.
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", permissions)
		if !keepsPocketBaseCSP(e.Request.URL.Path) {
			h.Set("Content-Security-Policy", appCSP)
		}
		return e.Next()
	})
}

func keepsPocketBaseCSP(path string) bool {
	return isDashboardPath(path) || strings.HasPrefix(path, "/api/files/")
}

func isDashboardPath(path string) bool {
	return path == "/_" || strings.HasPrefix(path, "/_/")
}

// loadCSP extracts the policy SvelteKit baked into index.html and appends
// frame-ancestors. Without an index.html (the no_ui build) it is the baseline
// alone. An index.html without the policy is a broken build, and the binary
// refuses to start rather than serve the app without its script policy. It
// reads an fs.FS because the SPA is embedded in the binary ([D-64]).
func loadCSP(publicFS fs.FS) string {
	if publicFS == nil {
		return baselineCSP
	}
	html, err := fs.ReadFile(publicFS, "index.html")
	if err != nil {
		return baselineCSP
	}
	m := metaCSPPattern.FindSubmatch(html)
	policy := ""
	if m != nil {
		policy = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(string(m[1])), ";"))
	}
	if policy == "" {
		panic("the embedded index.html has no Content-Security-Policy meta tag (vite.config.ts kit.csp): the SPA build is broken")
	}
	return policy + "; " + baselineCSP
}
