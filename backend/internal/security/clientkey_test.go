package security

import "testing"

// An IPv6 client counts by its /64, which one line is handed whole; IPv4,
// IPv4-mapped IPv6 included, by its address.
func TestClientKey(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		same bool
	}{
		{"2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", true},
		{"2001:db8:1:2::1", "2001:db8:1:3::1", false},
		{"fe80::1%eth0", "fe80::2", true},
		{"203.0.113.7", "203.0.113.8", false},
		{"::ffff:203.0.113.7", "203.0.113.7", true},
		{"::ffff:203.0.113.7", "::ffff:203.0.113.8", false},
		{"not an address", "not an address", true},
		{"not an address", "", false},
	} {
		if got := clientKey(tc.a) == clientKey(tc.b); got != tc.same {
			t.Errorf("clientKey(%q) = %q, clientKey(%q) = %q; same bucket = %v, want %v",
				tc.a, clientKey(tc.a), tc.b, clientKey(tc.b), got, tc.same)
		}
	}
	if got := clientKey("203.0.113.7"); got != "203.0.113.7" {
		t.Errorf("an IPv4 key = %q, want the address unchanged", got)
	}
}
