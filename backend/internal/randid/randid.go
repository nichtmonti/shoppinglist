// Package randid mints the server's random identifiers and secrets from
// crypto/rand.
package randid

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"

	pbsecurity "github.com/pocketbase/pocketbase/tools/security"
)

// Hex returns n bytes from crypto/rand as 2n hex characters. rand.Read never
// returns an error (it crashes rather than hand out predictable bytes), so
// there is none to propagate.
func Hex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ID returns 128 random bits as 32 hex characters, a valid PocketBase record
// id that cannot be guessed. Use it, not core.GenerateDefaultRandomId, which
// upstream calls "not intended for security purposes".
func ID() string {
	return Hex(16)
}

// Handle returns an account's identity handle (§4.2): 64 random bits as 16
// hex characters.
func Handle() string {
	return Hex(8)
}

// TokenBytes is a link token's length before base64url: 256 bits.
const TokenBytes = 32

// Token returns the secret a link carries (an invite, the setup link):
// TokenBytes from crypto/rand as unpadded base64url, 43 characters.
func Token() string {
	b := make([]byte, TokenBytes)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// maxTokenLen bounds a token from a request before it is hashed ([D-08]);
// Token's are 43 characters. Generous rather than exact, and refused as
// invalid, not malformed, so it is no oracle for "wrong shape".
const maxTokenLen = 64

// LookupHash is the hex sha256 a link's token is looked up by, for a token from a request: ok=false for an empty
// one or one longer than any link carries, which no link opens.
func LookupHash(token string) (string, bool) {
	if token == "" || len(token) > maxTokenLen {
		return "", false
	}
	return pbsecurity.SHA256(token), true
}
