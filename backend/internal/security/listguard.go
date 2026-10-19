package security

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/members"
)

// MemberRoutes is the group every list-scoped app route is registered on:
// AuthRoutes plus the membership gate on {listId}, since custom routes bypass
// PocketBase's collection API rules [D-74]. POST /api/lists/import is not on
// it: it has no source list.
func MemberRoutes(g *router.RouterGroup[*core.RequestEvent]) *router.RouterGroup[*core.RequestEvent] {
	return AuthRoutes(g).BindFunc(func(e *core.RequestEvent) error {
		if err := CheckListMembership(e.App, e); err != nil {
			return err
		}
		return e.Next()
	})
}

// CheckListMembership is the gate's verdict, taken on app. A route that writes
// in its own transaction takes it again on its txApp first: the §7.3 cascade
// may have deleted the list since the gate, and the write would leave rows no
// list owns ([D-192] made join check inside its transaction for the same race).
func CheckListMembership(app core.App, e *core.RequestEvent) error {
	member, err := members.IsMember(app, e.Auth.Id, e.Request.PathValue("listId"))
	if err != nil {
		// A failed lookup is not a verdict: a 403 tells the client it lost the list.
		return e.InternalServerError("failed to check membership", err)
	}
	if !member {
		// Same response for a missing list: must not leak list existence.
		return e.ForbiddenError("not a member of this list", nil)
	}
	return nil
}
