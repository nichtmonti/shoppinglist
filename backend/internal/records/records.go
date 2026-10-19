// Package records holds the small record-access idioms several route
// packages share.
package records

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// FindOptional is FindRecordById with absence as (nil, nil); any other error
// is a genuine failure, not "not there".
func FindOptional(app core.App, collection, id string) (*core.Record, error) {
	rec, err := app.FindRecordById(collection, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return rec, err
}

// FindFirstOptional is the first record of collection matching expr, with
// absence as (nil, nil) and any other error a genuine failure: a lookup that
// failed is never "not there" ([D-191]).
func FindFirstOptional(app core.App, collection string, expr dbx.Expression) (*core.Record, error) {
	rec := &core.Record{}
	err := app.RecordQuery(collection).AndWhere(expr).Limit(1).One(rec)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return rec, nil
}

// NullIfEmpty renders an empty text column as JSON null, the way every
// client-facing row shape carries an unset nullable field.
func NullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
