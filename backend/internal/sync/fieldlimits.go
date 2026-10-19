package sync

import (
	"math"

	"shoppinglist/internal/fieldcontract"
)

// The per-field byte caps live in internal/fieldcontract, shared with the
// frontend. The push route writes via SaveNoValidate, so PocketBase's field
// validation never runs: fieldProblems is the enforcement against storage
// exhaustion.

// Every writable field has one JSON type (fieldcontract.Type), and a value of
// another is refused, never coerced: the bool reads take any non-bool for
// false, which for `deleted` is a restore, and the byte cap reads strings
// only.

// typed reports whether v has the JSON type the field takes.
func typed(collection, field string, v any) bool {
	switch fieldcontract.Type(collection, field) {
	case fieldcontract.TypeBool:
		_, ok := v.(bool)
		return ok
	case fieldcontract.TypeNumber:
		// A whole number: the column is OnlyInt, which SaveNoValidate skips.
		n, ok := v.(float64)
		return ok && n == math.Trunc(n)
	default:
		_, ok := v.(string)
		return ok || v == nil
	}
}

// fieldProblems reports the first allowlist violation, the first cap
// violation and the first wrong-typed value in changed, in field order. A bad
// type is only reachable for a KNOWN field.
func fieldProblems(collection string, changed map[string]any) (unknown, oversized, badType string) {
	for _, field := range sortedFields(changed) {
		if isSignal(field) {
			if _, ok := changed[field].(bool); !ok && badType == "" {
				badType = field // a signal, not a column — but still bool
			}
			continue
		}
		if !fieldcontract.Writable(collection, field) {
			if unknown == "" {
				unknown = field
			}
			continue // an unknown field has no cap, so it can never be oversized
		}
		if !typed(collection, field, changed[field]) {
			if badType == "" {
				badType = field
			}
			continue // a mistyped value has no meaningful cap either
		}
		if oversized == "" {
			if limit, hasCap := fieldcontract.MaxBytes(collection, field); hasCap {
				if s, ok := changed[field].(string); ok && len(s) > limit {
					oversized = field
				}
			}
		}
	}
	return unknown, oversized, badType
}
