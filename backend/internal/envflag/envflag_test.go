package envflag

import (
	"strings"
	"testing"
)

// [D-222] An old-prefix variable that is set fails, naming its new name; one
// declared empty (compose passes "not configured" that way) does not.
func TestRenamedPrefix(t *testing.T) {
	t.Setenv("ENVFLAGTEST_OLD_ADMIN_UI", "off")
	t.Setenv("ENVFLAGTEST_OLD_RP_ID", "list.example.com")
	t.Setenv("ENVFLAGTEST_OLD_SIGNUP", "  ")
	err := RenamedPrefix("ENVFLAGTEST_OLD_", "ENVFLAGTEST_NEW_")
	if err == nil {
		t.Fatal("old names still set were accepted; their settings would silently not apply")
	}
	for _, want := range []string{
		"ENVFLAGTEST_OLD_ADMIN_UI → ENVFLAGTEST_NEW_ADMIN_UI",
		"ENVFLAGTEST_OLD_RP_ID → ENVFLAGTEST_NEW_RP_ID",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "SIGNUP") {
		t.Errorf("error %q names a variable that is only declared empty", err)
	}

	t.Setenv("ENVFLAGTEST_OLD_ADMIN_UI", "")
	t.Setenv("ENVFLAGTEST_OLD_RP_ID", "")
	if err := RenamedPrefix("ENVFLAGTEST_OLD_", "ENVFLAGTEST_NEW_"); err != nil {
		t.Errorf("only empty old names: %v, want nil", err)
	}
}

// [D-223] A removed setting is named as one to delete, not to rename: under
// the new prefix it would be ignored just the same.
func TestRenamedPrefixRemoved(t *testing.T) {
	t.Setenv("ENVFLAGTEST_OLD_ADMIN_UI", "off")
	t.Setenv("ENVFLAGTEST_OLD_DEFAULT_LOCALE", "de")
	err := RenamedPrefix("ENVFLAGTEST_OLD_", "ENVFLAGTEST_NEW_", "DEFAULT_LOCALE")
	if err == nil {
		t.Fatal("old names still set were accepted")
	}
	if !strings.Contains(err.Error(), "rename these: ENVFLAGTEST_OLD_ADMIN_UI → ENVFLAGTEST_NEW_ADMIN_UI") {
		t.Errorf("error %q does not ask to rename ADMIN_UI", err)
	}
	if !strings.Contains(err.Error(), "delete these, the settings are gone: ENVFLAGTEST_OLD_DEFAULT_LOCALE") {
		t.Errorf("error %q does not ask to delete DEFAULT_LOCALE", err)
	}
	if strings.Contains(err.Error(), "ENVFLAGTEST_NEW_DEFAULT_LOCALE") {
		t.Errorf("error %q offers a new name for a removed setting", err)
	}
}

// Every URL setting is a web address: an absolute http or https URL.
func TestAbsoluteURL(t *testing.T) {
	for _, tc := range []struct {
		v  string
		ok bool
	}{
		{"https://list.example.com", true},
		{"http://localhost:8090/x", true},
		{"list.example.com", false},
		{"https://", false},
		{"javascript://example.com/%0aalert(1)", false},
		{"ftp://example.com", false},
	} {
		if err := AbsoluteURL(tc.v); (err == nil) != tc.ok {
			t.Errorf("AbsoluteURL(%q) = %v, want ok=%v", tc.v, err, tc.ok)
		}
	}
}

// [D-336] A set name the server does not know fails the boot, named; one
// declared empty does not, nor a known one.
func TestUnknown(t *testing.T) {
	t.Setenv("ENVFLAGTEST_SIGNUPS", "closed")
	t.Setenv("ENVFLAGTEST_SIGNUP", "open")
	t.Setenv("ENVFLAGTEST_EMPTY", " ")
	known := []string{"ENVFLAGTEST_SIGNUP"}
	err := Unknown("ENVFLAGTEST_", known, "docs/deploy-reference.md")
	if err == nil {
		t.Fatal("a misspelt name was accepted; its setting would silently not apply")
	}
	if got := err.Error(); !strings.HasPrefix(got, "ENVFLAGTEST_SIGNUPS: ") || !strings.Contains(got, "docs/deploy-reference.md") ||
		strings.Contains(got, "EMPTY") || strings.Contains(got, "ENVFLAGTEST_SIGNUP:") {
		t.Errorf("error %q, want ENVFLAGTEST_SIGNUPS alone named, and where the settings are", got)
	}

	t.Setenv("ENVFLAGTEST_SIGNUPS", "")
	if err := Unknown("ENVFLAGTEST_", known, "docs/deploy-reference.md"); err != nil {
		t.Errorf("only known and empty names: %v, want nil", err)
	}
}
