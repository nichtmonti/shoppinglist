package oidc

import (
	"strings"
	"testing"
	"unicode/utf8"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/oidclogin"
)

// The nickname an OIDC-born account starts with: the first non-blank of the
// provider's name, username and email local part, else "" — the server holds
// no UI text, and the client renders its own placeholder for it.
func TestDisplayNamePicksTheFirstNonBlankClaim(t *testing.T) {
	cases := []struct {
		label, name, username, email, want string
	}{
		{"name claim", "Anna Schmidt", "anna", "anna@example.com", "Anna Schmidt"},
		{"username when no name", "", "anna", "anna@example.com", "anna"},
		{"email local part when neither", "", "", "anna.s@example.com", "anna.s"},
		{"blank claims are skipped", "   ", "\t", " anna@example.com", "anna"},
		{"surrounding space is trimmed", "  Anna ", "", "", "Anna"},
		{"nothing at all", "", "", "", ""},
		{"an email with no local part", "", "", "@example.com", ""},
	}
	for _, c := range cases {
		if got := displayName(c.name, c.username, c.email); got != c.want {
			t.Errorf("%s: displayName(%q, %q, %q) = %q, want %q", c.label, c.name, c.username, c.email, got, c.want)
		}
	}
}

// [D-08]: the nickname has one bound, whichever path writes it — this one
// included, where the value comes from the provider.
func TestDisplayNameHonoursTheContractCap(t *testing.T) {
	max, ok := fieldcontract.MaxBytes("accounts", "nickname")
	if !ok {
		t.Fatal("contract has no accounts.nickname cap")
	}
	got := displayName(strings.Repeat("ä", max), "", "") // 2 bytes each
	if len(got) > max {
		t.Errorf("len = %d bytes, want ≤ %d", len(got), max)
	}
	if !utf8.ValidString(got) {
		t.Errorf("truncated nickname is not valid UTF-8: %q", got)
	}
	if got == "" {
		t.Error("truncated to nothing")
	}
}

// [D-76]: what settings shows the OIDC login as — the provider's username,
// else the address, else nothing; never the name claim, which is already the
// nickname.
func TestIdentityLabelPrefersTheUsername(t *testing.T) {
	cases := []struct {
		label, username, email, want string
	}{
		{"username", "anna", "anna@example.com", "anna"},
		{"address when no username", "", "anna@example.com", "anna@example.com"},
		{"blank username is skipped", "  ", " anna@example.com ", "anna@example.com"},
		{"nothing at all", "", "", ""},
	}
	for _, c := range cases {
		if got := identityLabel(c.username, c.email); got != c.want {
			t.Errorf("%s: identityLabel(%q, %q) = %q, want %q", c.label, c.username, c.email, got, c.want)
		}
	}
	long := identityLabel(strings.Repeat("ä", oidclogin.MaxIdentityBytes), "")
	if len(long) > oidclogin.MaxIdentityBytes || !utf8.ValidString(long) {
		t.Errorf("an over-long label is %d bytes (valid UTF-8: %v), want at most %d", len(long), utf8.ValidString(long), oidclogin.MaxIdentityBytes)
	}
}
