package security

import (
	"errors"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// AuthRoutes is the group every authenticated app route is registered on, on
// top of g: the caller must be an account. PocketBase's RequireAuth answers
// 401 without a valid token and 403 for any other auth record, a superuser's
// included (see IsAccount).
//
// The webauthn begin/finish routes are not on it: they authenticate via the
// one-time ceremony session, not e.Auth.
func AuthRoutes(g *router.RouterGroup[*core.RequestEvent]) *router.RouterGroup[*core.RequestEvent] {
	return g.Group("").Bind(apis.RequireAuth("accounts"))
}

// IsAccount reports whether the request is authenticated as an app account.
// A superuser's token (SHOPPINGLIST_ADMIN_UI=on) also sets e.Auth, and every
// custom route would otherwise act on the superuser record as if it were one:
// /api/account/delete would delete it.
func IsAccount(e *core.RequestEvent) bool {
	return e.Auth != nil && e.Auth.Collection().Name == "accounts"
}

// RefusalOr500 answers the error of a handler's transaction: a refusal built
// inside it (an *router.ApiError) as it is, anything else as a 500 with
// message. Returned bare, a database error would reach the client as
// PocketBase's generic 400, the client's own fault ([D-191]).
func RefusalOr500(e *core.RequestEvent, message string, err error) error {
	if apiErr, ok := errors.AsType[*router.ApiError](err); ok {
		return apiErr
	}
	return e.InternalServerError(message, err)
}
