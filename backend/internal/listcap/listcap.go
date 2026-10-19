// Package listcap holds the deployment's storage caps: the [D-217] per-list
// items cap, which import and clone read too so no path makes a list the push
// route calls full, the [D-219] per-account lists cap, each a default an
// operator can move, and the fixed per-list categories cap (MaxCategories).
// Its own package because sync, lists and main all read it.
package listcap

import (
	"shoppinglist/internal/envflag"
	"shoppinglist/internal/fieldcontract"
)

// Env lets a deployment move the items cap.
const Env = "SHOPPINGLIST_MAX_ITEMS_PER_LIST"

// ListsEnv lets a deployment move the [D-219] lists cap.
const ListsEnv = "SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT"

// DefaultMaxLists is the lists cap of a deployment that did not set ListsEnv.
// Not in the shared contract: the client learns it from the refusal.
const DefaultMaxLists = 25

// Caps are a deployment's movable caps.
type Caps struct {
	// Items is how many items rows, tombstones included, a list may hold.
	Items int
	// Lists is how many lists one account may be a member of before creating,
	// importing or cloning another is refused. Lists joined through an invite
	// count, but joining is never refused: it stores nothing new.
	Lists int
}

// Default is the caps of a deployment that moved neither.
func Default() Caps {
	return Caps{Items: fieldcontract.MaxItemsPerList(), Lists: DefaultMaxLists}
}

// FromEnv parses Env and ListsEnv. Unset keeps the default; a non-number or
// anything below 1 is a boot error.
func FromEnv() (Caps, error) {
	items, err := envflag.PositiveInt(Env, fieldcontract.MaxItemsPerList(), "items per list")
	if err != nil {
		return Caps{}, err
	}
	lists, err := envflag.PositiveInt(ListsEnv, DefaultMaxLists, "lists per account")
	return Caps{Items: items, Lists: lists}, err
}

// ImportMax is how many items one backup may bring on this deployment: the
// contract's backup cap, or the list cap where that is lower.
func (c Caps) ImportMax() int { return min(fieldcontract.MaxBackupItems(), c.Items) }

// MaxCategories is how many list_categories rows, tombstones included, a list
// may hold before a push create of another is denied ([D-217]). Fixed, not a
// setting: a list starts with the seed's two dozen, a backup brings at most
// fieldcontract.MaxBackupCategories, and no household names 200 aisles, so
// the number only bounds storage. Import stays under it through the backup
// cap, clone copies a source already under it, and the missing-categories
// route adds each template at most once per list (the tombstone GC keeps a
// removed one's row, slug and all).
const MaxCategories = 200
