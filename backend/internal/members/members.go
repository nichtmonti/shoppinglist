// Package members reads and writes list membership: the one memberships row
// per (account, list) that every list-scoped permission rests on (§7).
//
// It is a leaf package so the route packages share it without importing each
// other.
package members

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/records"
)

// IsMember reports whether accountID is a member of listID. A failed lookup
// is returned as an error, never as "not a member": callers turn a false
// into a refusal the client acts on, so it must be a verdict.
func IsMember(app core.App, accountID, listID string) (bool, error) {
	n, err := app.CountRecords("memberships", dbx.HashExp{"account": accountID, "list": listID})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Find returns accountID's membership row for listID, or nil when there is
// none.
func Find(app core.App, accountID, listID string) (*core.Record, error) {
	return records.FindFirstOptional(app, "memberships", dbx.HashExp{"account": accountID, "list": listID})
}

// Add creates accountID's membership of listID with SaveNoValidate, for
// callers that just established both rows exist. The (account, list) unique
// index refuses a second row.
func Add(app core.App, accountID, listID string) (*core.Record, error) {
	col, err := app.FindCachedCollectionByNameOrId("memberships")
	if err != nil {
		return nil, err
	}
	rec := core.NewRecord(col)
	rec.Set("account", accountID)
	rec.Set("list", listID)
	if err := app.SaveNoValidate(rec); err != nil {
		return nil, err
	}
	return rec, nil
}
