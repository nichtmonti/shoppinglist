package testutil

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// Authenticator is a software passkey: one ES256 key, answering the options
// the §5.4 begin routes return with responses the finish routes verify for
// real. go-webauthn checks every byte it signs (challenge, origin, RP-ID hash,
// flags, signature), so a test driving it exercises the same checks a browser
// ceremony does, without a browser.
//
// The sign counter stays 0 unless a test sets Count, as on the platform
// authenticators most passkeys live in (iCloud Keychain, Google Password
// Manager).
type Authenticator struct {
	RPID   string
	Origin string
	// CredentialID is the passkey's id; Register creates it, a test may set it
	// to claim another passkey's id.
	CredentialID []byte
	// UserHandle is the user.id the RP gave at registration, which the
	// authenticator returns with every assertion.
	UserHandle []byte
	Count      uint32
	key        *ecdsa.PrivateKey
}

// NewAuthenticator returns an authenticator with a fresh P-256 key for rpID,
// sending origin in its client data.
func NewAuthenticator(t *testing.T, rpID, origin string) *Authenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("authenticator key: %v", err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &Authenticator{RPID: rpID, Origin: origin, CredentialID: id, key: key}
}

// PublicKey is the key in COSE form, as the credentials row stores it.
func (a *Authenticator) PublicKey() []byte {
	point, _ := a.key.PublicKey.Bytes() // 0x04 || X || Y
	b, _ := cbor.Marshal(struct {
		Kty int    `cbor:"1,keyasint"`
		Alg int    `cbor:"3,keyasint"`
		Crv int    `cbor:"-1,keyasint"`
		X   []byte `cbor:"-2,keyasint"`
		Y   []byte `cbor:"-3,keyasint"`
	}{Kty: 2, Alg: -7, Crv: 1, X: point[1:33], Y: point[33:65]})
	return b
}

// CredentialJSON is the go-webauthn Credential a registration of this key
// would have stored, for a test that puts the passkey on an account directly.
func (a *Authenticator) CredentialJSON() string {
	b, _ := json.Marshal(map[string]any{
		"id":              a.CredentialID,
		"publicKey":       a.PublicKey(),
		"attestationType": "none",
		"flags":           map[string]any{"userPresent": true, "userVerified": true},
		"authenticator":   map[string]any{"signCount": 0},
	})
	return string(b)
}

type beginOptions struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		User      struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"publicKey"`
}

func parseOptions(t *testing.T, begin string) beginOptions {
	t.Helper()
	var o beginOptions
	if err := json.Unmarshal([]byte(begin), &o); err != nil || o.PublicKey.Challenge == "" {
		t.Fatalf("not a begin response: %v %s", err, begin)
	}
	return o
}

func (a *Authenticator) clientData(typ, challenge string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": a.Origin})
	return b
}

// authData is rpIdHash || flags || signCount, plus the attested credential
// (AAGUID, id, key) when attested.
func (a *Authenticator) authData(attested bool) []byte {
	h := sha256.Sum256([]byte(a.RPID))
	out := append([]byte{}, h[:]...)
	flags := byte(0x01 | 0x04) // user present, user verified
	if attested {
		flags |= 0x40
	}
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, a.Count)
	if attested {
		out = append(out, make([]byte, 16)...) // AAGUID: none
		// WebAuthn caps a credential id at 1023 bytes; a test that sets a
		// longer one gets told so instead of a silently wrapped length.
		n := len(a.CredentialID)
		if n > 1023 {
			panic(fmt.Sprintf("testutil: credential id of %d bytes, WebAuthn allows 1023", n))
		}
		out = binary.BigEndian.AppendUint16(out, uint16(n))
		out = append(out, a.CredentialID...)
		out = append(out, a.PublicKey()...)
	}
	return out
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// Register answers a register/begin response with the body register/finish
// takes: a "none" attestation of this key, and remembers the user handle.
func (a *Authenticator) Register(t *testing.T, begin string) string {
	t.Helper()
	o := parseOptions(t, begin)
	handle, err := base64.RawURLEncoding.DecodeString(o.PublicKey.User.ID)
	if err != nil {
		t.Fatalf("user.id: %v", err)
	}
	a.UserHandle = handle
	att, _ := cbor.Marshal(map[string]any{
		"fmt":      "none",
		"attStmt":  map[string]any{},
		"authData": a.authData(true),
	})
	b, _ := json.Marshal(map[string]any{
		"id": b64(a.CredentialID), "rawId": b64(a.CredentialID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(a.clientData("webauthn.create", o.PublicKey.Challenge)),
			"attestationObject": b64(att),
		},
	})
	return string(b)
}

// Assert answers a login/begin response with the body login/finish takes,
// signed with this key and carrying a.UserHandle.
func (a *Authenticator) Assert(t *testing.T, begin string) string {
	t.Helper()
	o := parseOptions(t, begin)
	cd := a.clientData("webauthn.get", o.PublicKey.Challenge)
	ad := a.authData(false)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), cdHash[:]...))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sig, _ := asn1.Marshal(struct{ R, S *big.Int }{r, s})
	b, _ := json.Marshal(map[string]any{
		"id": b64(a.CredentialID), "rawId": b64(a.CredentialID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(cd),
			"authenticatorData": b64(ad),
			"signature":         b64(sig),
			"userHandle":        b64(a.UserHandle),
		},
	})
	return string(b)
}
