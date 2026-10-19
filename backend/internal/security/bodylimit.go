package security

import (
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"
)

// SmallBodyMax bounds the body of every app route unless it opts into
// LargeBody: a few short fields, a passkey ceremony (a credential with its
// attestation is a few KB), an invite token, a target account's token, a
// name. Far above what they accept, and far below PocketBase's 32 MiB default,
// which let parallel unauthenticated passkey finishes hold the container's
// whole memory (§10).
const SmallBodyMax = 64 << 10

// AppRoutes is the group every app route is registered on: the same paths
// as the root router, with SmallBodyMax in place of PocketBase's default (the
// same middleware id, so the group's wins). A longer body is a 413.
// PocketBase's own routes sit in their own group and keep their limits.
func AppRoutes(r *router.Router[*core.RequestEvent]) *router.RouterGroup[*core.RequestEvent] {
	g := r.Group("")
	g.Bind(apis.BodyLimit(SmallBodyMax))
	return g
}

// LargeBody puts PocketBase's default back on one route, for push and import,
// whose own op, row and field caps decide their size: a worst-case escaped
// batch or backup needs it. A route's limit beats its group's (same id).
func LargeBody() *hook.Handler[*core.RequestEvent] {
	return apis.BodyLimit(apis.DefaultMaxBodySize)
}
