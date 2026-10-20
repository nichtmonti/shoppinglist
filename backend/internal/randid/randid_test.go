package randid

import (
	"strings"
	"testing"

	pbsecurity "github.com/pocketbase/pocketbase/tools/security"
)

// LookupHash refuses what no link carries before hashing it ([D-08]).
func TestLookupHash(t *testing.T) {
	for _, token := range []string{"", strings.Repeat("x", maxTokenLen+1)} {
		if _, ok := LookupHash(token); ok {
			t.Errorf("LookupHash accepted a %d-character token", len(token))
		}
	}
	token := Token()
	if h, ok := LookupHash(token); !ok || h != pbsecurity.SHA256(token) {
		t.Errorf("LookupHash(Token()) = %q, %v; want its sha256", h, ok)
	}
}
