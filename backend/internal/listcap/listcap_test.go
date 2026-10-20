package listcap

import (
	"testing"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/settings"
)

// FromEnv reads the caps as the start does, for the tests that set them.
func FromEnv() (Caps, error) {
	s, err := settings.ReadServe()
	return FromSettings(s), err
}

// DefaultMaxLists is the lists cap with nothing set.
var DefaultMaxLists = Default().Lists

// Env: unset keeps the contract's number, and a value that is not a whole
// number of at least 1 fails rather than falling back. There is no other
// floor: ImportMax follows the cap down.
func TestFromEnv(t *testing.T) {
	for _, tc := range []struct {
		value   string
		want    int
		wantErr bool
	}{
		{"", fieldcontract.MaxItemsPerList(), false},
		{"  ", fieldcontract.MaxItemsPerList(), false},
		{"20000", 20000, false},
		{"1", 1, false},
		{"0", 0, true},
		{"-5", 0, true},
		{"5k", 0, true},
	} {
		t.Setenv(Env, tc.value)
		caps, err := FromEnv()
		got := caps.Items
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s=%q accepted as %d, want a boot error", Env, tc.value, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s=%q = %d, %v; want %d", Env, tc.value, got, err, tc.want)
		}
	}
}

// ImportMax is the backup cap until the list cap is lower, then the list cap.
func TestImportMax(t *testing.T) {
	backup := fieldcontract.MaxBackupItems()
	for _, tc := range []struct{ cap, want int }{
		{fieldcontract.MaxItemsPerList(), backup},
		{backup, backup},
		{backup - 1, backup - 1},
		{10, 10},
	} {
		if got := (Caps{Items: tc.cap}).ImportMax(); got != tc.want {
			t.Errorf("cap %d: ImportMax = %d, want %d", tc.cap, got, tc.want)
		}
	}
}

// ListsEnv: unset keeps the default of 25, and a value that is not a whole
// number of at least 1 fails rather than falling back.
func TestFromEnvLists(t *testing.T) {
	for _, tc := range []struct {
		value   string
		want    int
		wantErr bool
	}{
		{"", DefaultMaxLists, false},
		{"  ", DefaultMaxLists, false},
		{"100", 100, false},
		{"1", 1, false},
		{"0", 0, true},
		{"-1", 0, true},
		{"many", 0, true},
	} {
		t.Setenv(ListsEnv, tc.value)
		caps, err := FromEnv()
		got := caps.Lists
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s=%q accepted as %d, want a boot error", ListsEnv, tc.value, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s=%q = %d, %v; want %d", ListsEnv, tc.value, got, err, tc.want)
		}
	}
	if DefaultMaxLists != 25 {
		t.Errorf("DefaultMaxLists = %d, want 25", DefaultMaxLists)
	}
}
