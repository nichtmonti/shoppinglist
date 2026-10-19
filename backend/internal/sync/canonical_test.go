package sync

import (
	"encoding/json"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// TestCanonical_AgreesWithJSONCanonical pins that jsonCanonical gives a
// record field's value, read back after a Set, the same form as the
// JSON-decoded value it was set from. The merge compares the two, so a
// divergence would make every field look perpetually conflicted. Each value
// is set both as a Go value and as its JSON-decoded twin (numbers float64,
// null nil), the form op.Changed arrives in.
func TestCanonical_AgreesWithJSONCanonical(t *testing.T) {
	app, _ := setupSyncApp(t)
	col, err := app.FindCollectionByNameOrId(collectionItems)
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}

	cases := []struct {
		name  string
		field string
		value any
	}{
		{"bool true", "checked", true},
		{"bool false", "checked", false},
		{"float64 3", "quantity", float64(3)},
		{"int 3", "quantity", int(3)},
		{"int64 3", "quantity", int64(3)},
		{"nil", "quantity", nil},
		{"string x", "quantity", "x"},
		{"string empty", "quantity", ""},
		{"string 0", "quantity", "0"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The wire only ever carries JSON-decoded values (json.Unmarshal
			// yields float64 for numbers, never Go int), so the jsonCanonical
			// side of each pair is the value AFTER a marshal→unmarshal
			// round-trip — that is the input the server actually sees.
			wire, err := json.Marshal(tc.value)
			if err != nil {
				t.Fatalf("marshal %v: %v", tc.value, err)
			}
			var decoded any
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatalf("unmarshal %q: %v", wire, err)
			}

			// Typed set
			rec := core.NewRecord(col)
			rec.Set(tc.field, tc.value)
			if got, want := jsonCanonical(rec.Get(tc.field)), jsonCanonical(decoded); got != want {
				t.Errorf("typed set: read back = %q, jsonCanonical = %q", got, want)
			}

			// JSON-decoded twin (the wire path)
			rec2 := core.NewRecord(col)
			rec2.Set(tc.field, decoded)
			if got, want := jsonCanonical(rec2.Get(tc.field)), jsonCanonical(decoded); got != want {
				t.Errorf("decoded set: read back = %q, jsonCanonical = %q", got, want)
			}
		})
	}
}
