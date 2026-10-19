// Package tombstone holds the one predicate for "is this row deleted"
// (§6.6 deleted_at) on an in-memory record. SQL sites test deleted_at
// themselves.
package tombstone

import "github.com/pocketbase/pocketbase/core"

// Deleted reports whether the record carries the tombstone (deleted_at set).
func Deleted(rec *core.Record) bool {
	return !rec.GetDateTime("deleted_at").IsZero()
}

// Living is the complement of Deleted.
func Living(rec *core.Record) bool { return !Deleted(rec) }
