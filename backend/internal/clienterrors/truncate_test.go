package clienterrors

import (
	"strings"
	"testing"
)

// A value is cut to its byte cap on a rune boundary, whatever precedes the
// cut: an invalid byte early in the value must not cost the rest of it.
func TestTruncateKeepsTheValueUpToTheCap(t *testing.T) {
	in := "\xff" + strings.Repeat("a", 600)
	got := truncate(in, 500)
	if want := in[:500] + "…"; got != want {
		t.Errorf("truncate kept %d bytes, want 500 and an ellipsis", len(got)-len("…"))
	}
	if got := truncate(strings.Repeat("ä", 300), 501); got != strings.Repeat("ä", 250)+"…" {
		t.Errorf("a cut inside a rune must back off to its start, got %d bytes", len(got))
	}
}
