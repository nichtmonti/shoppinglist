package migrations

// Helpers shared across the migrations. A migration is history, and these
// build what several of them store: a change to what one returns changes every
// migration that calls it, already-applied ones included — membershipRule's
// text is the collection API rule of lists, items, list_categories and invites.
//
// The binary wires no migrate command, so a down step runs only in a test: a
// new migration registers a nil down unless a test reverts it. An index is
// added and removed by name (core.Collection's AddIndex, RemoveIndex).

import "github.com/pocketbase/pocketbase/core"

// addTimestamps adds the `created` and `updated` autodate fields that docs/internals/design.md
// §6 / [D-40] assume every record collection has ("updated is server-stamped on
// every write, PB built-in"). NOTE: PocketBase's NewBaseCollection /
// NewAuthCollection only auto-add the `id` (and auth) fields — they do NOT add
// created/updated (initDefaultFields adds nothing else), so they must be added
// explicitly here. Without `updated` the §8.5 digest hash and the push settle's
// base invariant have nothing to track.
func addTimestamps(c *core.Collection) {
	c.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
}

// membershipRule is the cross-collection rule fragment that asserts the
// requester is a member of the collection row's list (docs/internals/design.md §11). The
// repeated @collection.memberships.* reference binds both conditions to the
// SAME membership row via PB's single-join semantics. listField is the row-side
// list id expression: "list.id" for collections that carry a `list` field
// (items, list_categories, invites), "id" for the `lists` collection itself.
func membershipRule(listField string) string {
	return "@request.auth.id != '' && @collection.memberships.account.id ?= @request.auth.id && @collection.memberships.list.id ?= " + listField
}
