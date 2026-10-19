// Migration 1778000018 — any member can share a list's link ([D-294]).
//
// `invites.token` holds a live link's token, so every member's share sheet can
// show it, not only the device that minted it. The collection's existing
// member-only list and view rules (§11) gate it; a revocation blanks it
// (internal/invites/manage.go RevokeLive). Links minted before this have none:
// they read as unavailable until they are reset or expire.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(inviteTokenForMembersUp, inviteTokenForMembersDown, "1778000018_invite_token_for_members.go")
}

func inviteTokenForMembersUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		return err
	}
	col.Fields.Add(&core.TextField{Name: "token"})
	return app.Save(col)
}

func inviteTokenForMembersDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("token")
	return app.Save(col)
}
