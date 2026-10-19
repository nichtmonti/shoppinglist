// The §7.3 departure hook: every departure revokes the list's live invite
// link, and the last one hard-deletes the list and everything that hangs off
// it.

package lists

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/invites"
)

// listChildren are the tables that hang off a list, deleted in this order
// before the list row itself.
var listChildren = []string{"items", "list_categories", "invites", "merge_log"}

// onMembershipDelete deletes the membership, revokes the list's live invite
// link and, if no memberships remain, hard-deletes the list's children and
// the list row. e.App is the delete's transaction; SQLite serializes writers,
// so of two concurrent leaves exactly one counts zero.
func onMembershipDelete(e *core.RecordEvent) error {
	if err := e.Next(); err != nil {
		return err
	}
	listID := e.Record.GetString("list")

	// Revoke the live link on ANY departure, so a leaver cannot rejoin with
	// it; revoked, not deleted, to keep the audit row (§7.6). Not scoped to
	// the leaver's own invites: they know the secret whoever minted it
	// ([D-31]).
	if _, err := invites.RevokeLive(e.App, listID); err != nil {
		return err
	}

	n, err := e.App.CountRecords("memberships", dbx.HashExp{"list": listID})
	if err != nil || n > 0 {
		return err // other members remain, nothing to cascade
	}

	// Raw bulk deletes rather than app.Delete() per row: these collections
	// have no delete hooks to preserve, and no members remain to receive
	// realtime events.
	for _, table := range listChildren {
		if _, err := e.App.DB().Delete(table, dbx.HashExp{"list": listID}).Execute(); err != nil {
			return err
		}
	}
	_, err = e.App.DB().Delete("lists", dbx.HashExp{"id": listID}).Execute()
	return err
}
