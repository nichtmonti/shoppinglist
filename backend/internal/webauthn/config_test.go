package webauthn

import (
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
)

// [D-201] Since go-webauthn v0.18 an extension output the Relying Party did not
// request fails the ceremony by default. This app requests none, and some
// authenticators and password managers return one unprompted — a sign-in that
// fails there locks a user out, and the e2e virtual authenticator never sends
// such an output, so nothing else would notice the default coming back.
func TestUnsolicitedExtensionOutputsAreIgnored(t *testing.T) {
	wa, err := New(&Config{RPID: "localhost", RPDisplayName: "Test", RPOrigin: "http://localhost:8090"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := wa.Config.ExtensionsUnsolicitedOutputPolicy; got != protocol.UnsolicitedOutputPolicyIgnore {
		t.Fatalf("ExtensionsUnsolicitedOutputPolicy = %v, want UnsolicitedOutputPolicyIgnore", got)
	}
}
