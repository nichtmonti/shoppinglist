// Remote-administration lockdown (SHOPPINGLIST_ADMIN_UI, §10).

package security

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/envflag"
)

// AdminUIEnv switches remote administration off.
const AdminUIEnv = "SHOPPINGLIST_ADMIN_UI"

// superuserAPIPrefix is the dashboard's auth API. Blocking it is the cheap
// path; RegisterSuperuserAuthGuard makes the block airtight, since the
// collection can also be addressed by its system id.
const superuserAPIPrefix = "/api/collections/_superusers/"

// AdminUIFromEnv parses SHOPPINGLIST_ADMIN_UI, reporting whether remote
// administration stays enabled. Unset means on. An unrecognised value is
// fatal ([D-61]): a deployment that meant "off" must not boot believing it is
// locked down.
func AdminUIFromEnv() (bool, error) {
	return envflag.OnOff(AdminUIEnv, true)
}

// RegisterAdminLockdown makes PocketBase's dashboard and its auth API vanish.
//
// A middleware, not a replacement route: apis.Serve registers `GET /_/...`
// before OnServe, and the router panics on a duplicate pattern.
//
// Bind it AFTER security.Register: the 404 returns without e.Next(), so
// bound first it would leave every security header unset.
//
// 404 rather than 403: a 403 confirms there is something to come back for.
func RegisterAdminLockdown(r *router.Router[*core.RequestEvent]) {
	r.BindFunc(func(e *core.RequestEvent) error {
		p := e.Request.URL.Path
		if isDashboardPath(p) || strings.HasPrefix(p, superuserAPIPrefix) {
			return e.NotFoundError("", nil)
		}
		return e.Next()
	})
}

// RegisterSuperuserAuthGuard refuses to issue a superuser token over HTTP.
//
// It is the half of the lockdown that cannot be routed around: the hook is
// tagged with the collection itself, so it fires for every auth method no
// matter which URL (name or system id) reached it. It runs on the auth
// RESPONSE, so a password is still compared first; the path prefix in
// RegisterAdminLockdown stops that work earlier. With this on, administration
// is shell-only (docs/deploy-reference.md).
func RegisterSuperuserAuthGuard(app core.App) {
	app.OnRecordAuthRequest(core.CollectionNameSuperusers).BindFunc(
		func(e *core.RecordAuthRequestEvent) error {
			return e.ForbiddenError("remote superuser authentication is disabled", nil)
		})
}
