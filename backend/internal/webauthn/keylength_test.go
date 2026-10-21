package webauthn

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
)

// A passkey's RSA key under NIST's 2030 floor is refused; one at it, and an
// elliptic-curve key, pass.
func TestCheckKeyLength(t *testing.T) {
	rsaKey := func(bits int) []byte {
		modulus := append([]byte{0x80}, bytes.Repeat([]byte{0x01}, bits/8-1)...)
		b, err := webauthncbor.Marshal(webauthncose.RSAPublicKeyData{
			KeyType:   int64(webauthncose.RSAKey),
			Algorithm: int64(webauthncose.AlgRS256),
			Modulus:   modulus,
			Exponent:  []byte{0x01, 0x00, 0x01},
		})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecKey, err := webauthncbor.Marshal(webauthncose.EC2PublicKeyData{
		KeyType:   int64(webauthncose.EllipticKey),
		Algorithm: int64(webauthncose.AlgES256),
		Curve:     1, // P-256
		XCoord:    ec.X.FillBytes(make([]byte, 32)),
		YCoord:    ec.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := checkKeyLength(rsaKey(1024)); err == nil {
		t.Error("a 1024-bit RSA key passed")
	}
	if err := checkKeyLength(rsaKey(2048)); err != nil {
		t.Errorf("a 2048-bit RSA key was refused: %v", err)
	}
	if err := checkKeyLength(ecKey); err != nil {
		t.Errorf("a P-256 key was refused: %v", err)
	}
}
