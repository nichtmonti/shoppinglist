// Package fieldcontract holds the single definition of the values client and
// server must agree on: what a client may write through the §8.3 push route
// (the per-collection writable-field allowlist, the per-field byte caps, the
// server-stamped columns that never appear in an op, the
// per-request op cap),
// the byte caps of the other client-written columns (nickname, passkey label,
// list name), the [D-72] backup envelope, the `denied` reason codes and push
// statuses, the lists-cap refusal, the demo lifetime, the category palette,
// and the canonical row shape.
//
// Copies that disagree lose data silently, so field-contract.json is the one
// source both sides read: Go embeds it here, TypeScript imports it in
// frontend/src/lib/field-contract.ts.
package fieldcontract

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

//go:embed field-contract.json
var contractJSON []byte

// fieldSpec is one writable field: its JSON type ("bool" or "number", text
// when absent) and, for text, its byte cap.
type fieldSpec struct {
	MaxBytes int    `json:"max_bytes"`
	Type     string `json:"type"`
}

type collectionSpec struct {
	Writable map[string]fieldSpec `json:"writable"`
}

// backupSpec is the [D-72] per-list backup envelope: the format tag, the
// document version, and the row caps.
type backupSpec struct {
	Format        string `json:"format"`
	Version       int    `json:"version"`
	MaxCategories int    `json:"max_categories"`
	MaxItems      int    `json:"max_items"`
}

// listLimitSpec is the [D-219] refusal of a list past the lists cap.
type listLimitSpec struct {
	Status int    `json:"status"`
	Code   string `json:"code"`
}

type contract struct {
	MaxOpsPerPush     int                       `json:"max_ops_per_push"`
	MaxItemsPerList   int                       `json:"max_items_per_list"`
	Backup            backupSpec                `json:"backup"`
	ServerStamped     []string                  `json:"server_stamped"`
	Collections       map[string]collectionSpec `json:"collections"`
	DeniedReasons     []string                  `json:"denied_reasons"`
	PushStatuses      []string                  `json:"push_statuses"`
	ListLimit         listLimitSpec             `json:"list_limit"`
	DemoLifetimeHours int                       `json:"demo_lifetime_hours"`
	Palette           []string                  `json:"palette"`
	RowShape          map[string][]string       `json:"row_shape"`
}

var loaded contract

func init() {
	if err := json.Unmarshal(contractJSON, &loaded); err != nil {
		// Embedded at build time: a parse failure is a broken build.
		panic(fmt.Sprintf("fieldcontract: cannot parse field-contract.json: %v", err))
	}
	if loaded.MaxOpsPerPush <= 0 {
		panic("fieldcontract: max_ops_per_push missing or non-positive")
	}
	if loaded.MaxItemsPerList <= 0 {
		panic("fieldcontract: max_items_per_list missing or non-positive")
	}
	if loaded.Backup.Format == "" || loaded.Backup.Version <= 0 ||
		loaded.Backup.MaxCategories <= 0 || loaded.Backup.MaxItems <= 0 {
		panic("fieldcontract: backup envelope missing or non-positive")
	}
	if len(loaded.DeniedReasons) == 0 {
		panic("fieldcontract: denied_reasons missing or empty")
	}
	if loaded.DemoLifetimeHours <= 0 {
		panic("fieldcontract: demo_lifetime_hours missing or non-positive")
	}
	if len(loaded.Palette) == 0 {
		panic("fieldcontract: palette missing or empty")
	}
	if len(loaded.RowShape["items"]) == 0 || len(loaded.RowShape["list_categories"]) == 0 {
		panic("fieldcontract: row_shape missing items or list_categories")
	}
	for name, col := range loaded.Collections {
		for field, spec := range col.Writable {
			if spec.Type != "" && spec.Type != TypeBool && spec.Type != TypeNumber {
				panic(fmt.Sprintf("fieldcontract: %s.%s has unknown type %q", name, field, spec.Type))
			}
		}
	}
}

// Writable reports whether a client may set this field on this collection.
// Unknown collections and unknown fields are both false (deny by default).
func Writable(collection, field string) bool {
	_, ok := loaded.Collections[collection].Writable[field]
	return ok
}

// The JSON types a writable field can take: Type's answers.
const (
	TypeText   = "text"
	TypeBool   = "bool"
	TypeNumber = "number"
)

// Type returns the JSON type a writable field takes: TypeBool, TypeNumber,
// or TypeText (a string, or null to clear it). A value of another type is
// refused, never coerced.
func Type(collection, field string) string {
	if t := loaded.Collections[collection].Writable[field].Type; t != "" {
		return t
	}
	return TypeText
}

// MaxBytes returns the UTF-8 byte cap for a field, and whether one applies.
// ok is false for non-string fields and for anything not in the allowlist.
func MaxBytes(collection, field string) (int, bool) {
	f := loaded.Collections[collection].Writable[field]
	return f.MaxBytes, f.MaxBytes > 0
}

// OverCap returns a "field <collection>.<field> exceeds its cap" message when
// value is longer than the field's byte cap, or "" when it fits or no cap
// applies. It is the shared check of the routes that refuse an over-long
// value with a 400 ([D-08]).
func OverCap(collection, field, value string) string {
	limit, ok := MaxBytes(collection, field)
	if !ok || len(value) <= limit {
		return ""
	}
	return fmt.Sprintf("field %s.%s exceeds its cap", collection, field)
}

// Truncate cuts value to the field's byte cap with CutBytes, for values from
// outside the app and as a last resort behind writes already validated. It is
// never the check for a user's own input: silently shortening it is worse
// than refusing it with OverCap.
func Truncate(collection, field, value string) string {
	limit, ok := MaxBytes(collection, field)
	if !ok {
		return value
	}
	return CutBytes(value, limit)
}

// CutBytes returns value cut to at most limit bytes, backing off to a rune
// start so a valid UTF-8 value stays valid.
func CutBytes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

// MaxOpsPerPush returns the maximum ops a single §8.3 push request may carry.
// The client chunks its drain to the same bound (frontend/src/lib/field-contract.ts).
func MaxOpsPerPush() int { return loaded.MaxOpsPerPush }

// MaxItemsPerList returns the default cap on a list's items rows, tombstones
// included (`list_full`, [D-217]). The cap a deployment runs is
// internal/listcap's.
func MaxItemsPerList() int { return loaded.MaxItemsPerList }

// BackupFormat is the `format` tag every backup document carries.
func BackupFormat() string { return loaded.Backup.Format }

// BackupVersion is the one document version this build writes and accepts;
// any other is refused, not migrated ([D-72]).
func BackupVersion() int { return loaded.Backup.Version }

// MaxBackupCategories / MaxBackupItems bound one backup document.
func MaxBackupCategories() int { return loaded.Backup.MaxCategories }
func MaxBackupItems() int      { return loaded.Backup.MaxItems }

// DeniedReasons returns the `denied` reason codes the §8.3 push route can
// return; the client's DeniedReason union is pinned to it.
func DeniedReasons() []string { return loaded.DeniedReasons }

// ServerStamped returns the columns the server stamps, which no op may carry.
func ServerStamped() []string { return loaded.ServerStamped }

// PushStatuses returns the per-op statuses a §8.3 push result can carry; the
// pushStatus consts and the client's PUSH_STATUSES are pinned to it.
func PushStatuses() []string { return loaded.PushStatuses }

// ListLimit returns the HTTP status and body code of the [D-219] refusal the
// list-making routes share; the client recognises it by the same two values.
func ListLimit() (status int, code string) {
	return loaded.ListLimit.Status, loaded.ListLimit.Code
}

// DemoLifetimeHours is how long a demo account lives ([D-234]); the client's
// countdown reads the same number.
func DemoLifetimeHours() int { return loaded.DemoLifetimeHours }

// Palette returns the curated category color tokens [D-37].
func Palette() []string { return loaded.Palette }

// RowShape returns the canonical client-facing row columns for a collection,
// and whether the contract carries one.
func RowShape(collection string) ([]string, bool) {
	cols, ok := loaded.RowShape[collection]
	return cols, ok
}
