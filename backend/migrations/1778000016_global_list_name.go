// Migration 1778000016 — the list name becomes one name per list ([D-08]).
//
// Before it, each member named a list privately (`memberships.display_name`,
// [D-08]), so two members of one list could not tell from their screens that
// they meant the same list. The name lives on the `lists` row, readable by every member (the existing ListRule) and
// writable by every member (UpdateRule below; the lists package's update guard
// caps it and keeps it non-empty).
//
// Backfill: a list takes the name its EARLIEST membership gave it — the
// creator's, for a list made by §7.5 (the creator's row is written in the same
// transaction as the list), else the longest-standing member's. The per-member
// columns then go: `memberships.display_name` and the invite's
// `display_name` seed for the joiner's private name. With nothing left on a
// membership for its owner to change, memberships loses its UpdateRule too.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(globalListNameUp, globalListNameDown, "1778000016_global_list_name.go")
}

func globalListNameUp(app core.App) error {
	lists, err := app.FindCollectionByNameOrId("lists")
	if err != nil {
		return err
	}
	lists.Fields.Add(&core.TextField{Name: "name"})
	// Go guard: lists.listUpdateGuard (internal/lists/guard.go) bounds the name.
	lists.UpdateRule = new(membershipRule("id"))
	if err := app.Save(lists); err != nil {
		return err
	}

	if _, err := app.DB().NewQuery(
		"UPDATE lists SET name = COALESCE((SELECT m.display_name FROM memberships m" +
			" WHERE m.list = lists.id ORDER BY m.created, m.id LIMIT 1), '')",
	).Execute(); err != nil {
		return err
	}

	memberships, err := app.FindCollectionByNameOrId("memberships")
	if err != nil {
		return err
	}
	memberships.Fields.RemoveByName("display_name")
	memberships.UpdateRule = nil
	if err := app.Save(memberships); err != nil {
		return err
	}

	invites, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		return err
	}
	invites.Fields.RemoveByName("display_name")
	return app.Save(invites)
}

// globalListNameDown restores the per-member columns, giving every member the
// list's one name — the closest the old model has to it. It restores the
// own-row memberships.UpdateRule too, which is safe only under a binary that
// still has membershipUpdateGuard (pre-[D-08]): roll back the code with it.
func globalListNameDown(app core.App) error {
	invites, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		return err
	}
	invites.Fields.Add(&core.TextField{Name: "display_name"})
	if err := app.Save(invites); err != nil {
		return err
	}

	memberships, err := app.FindCollectionByNameOrId("memberships")
	if err != nil {
		return err
	}
	memberships.Fields.Add(&core.TextField{Name: "display_name"})
	memberships.UpdateRule = new("account = @request.auth.id")
	if err := app.Save(memberships); err != nil {
		return err
	}
	if _, err := app.DB().NewQuery(
		"UPDATE memberships SET display_name = COALESCE((SELECT l.name FROM lists l WHERE l.id = memberships.list), '')",
	).Execute(); err != nil {
		return err
	}

	lists, err := app.FindCollectionByNameOrId("lists")
	if err != nil {
		return err
	}
	lists.Fields.RemoveByName("name")
	lists.UpdateRule = nil
	return app.Save(lists)
}
