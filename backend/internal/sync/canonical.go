package sync

import (
	"maps"
	"slices"
	"strconv"
)

// sortedFields returns changed's keys in order, so the conflicts (whose first
// entry the client's toast reads) are deterministic.
func sortedFields(changed map[string]any) []string {
	return slices.Sorted(maps.Keys(changed))
}

// stringFromChanged is a text field's value in an op, "" when absent or not a string.
func stringFromChanged(changed map[string]any, key string) string {
	if v, ok := changed[key].(string); ok {
		return v
	}
	return ""
}

// boolFromChanged returns the bool value of a key (false if absent/non-bool).
func boolFromChanged(changed map[string]any, key string) bool {
	if v, ok := changed[key].(bool); ok {
		return v
	}
	return false
}

// isSignal reports whether a key of changed is a signal rather than a column:
// `deleted` stamps deleted_at ([D-45]), and `bought` (only ever false, with an
// untick) says the tick it takes back was not a purchase ([D-26]).
func isSignal(field string) bool {
	return field == "deleted" || field == "bought"
}

// notBought reports whether an untick says the item was not bought: the undo of
// a tick, or putting a ticked item back during the trip.
func notBought(changed map[string]any) bool {
	v, ok := changed["bought"].(bool)
	return ok && !v
}

// jsonCanonical returns a comparable canonical form of a JSON-unmarshaled value
// from Changed/Base or a record field's current value. Strings stay strings;
// bool → "true"/"false"; numbers → integers; nil and anything else → "".
func jsonCanonical(v any) string {
	switch x := v.(type) {
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatInt(int64(x), 10)
	case string:
		return x
	default:
		return ""
	}
}
