package webauthn

import (
	"bytes"
	"encoding/base64"
	"testing"

	wlib "github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// TestLoginComparesTheRegisteredUserHandle ([D-153]): the authenticator
// returns the user handle a passkey was registered under for its whole life.
// Once the [D-76] link has moved the credential to another account, login
// must compare against THAT handle, not the new owner's id — comparing
// against the owner's id failed every moved passkey's login/finish with a 400.
func TestLoginComparesTheRegisteredUserHandle(t *testing.T) {
	app := testutil.NewApp(t)
	sourceID, _ := testutil.CreateAccount(t, app, "Anna")
	targetID, _ := testutil.CreateAccount(t, app, "Bob")

	// Registered for the source account, exactly as registerFinish persists it...
	rawID := []byte("credential-1")
	if err := persistCredential(app, sourceID, &wlib.Credential{ID: rawID}, ""); err != nil {
		t.Fatalf("persistCredential: %v", err)
	}
	// ...then moved by the link, which re-points only the owner.
	cred, err := app.FindFirstRecordByData("credentials", "credential_id",
		base64.RawURLEncoding.EncodeToString(rawID))
	if err != nil {
		t.Fatalf("find credential: %v", err)
	}
	cred.Set("account", targetID)
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatalf("move credential: %v", err)
	}

	user, err := resolveUserFromCredential(&core.RequestEvent{App: app}, rawID, []byte(sourceID))
	if err != nil {
		t.Fatalf("resolveUserFromCredential: %v", err)
	}
	if got := user.(*accountUser).record.Id; got != targetID {
		t.Errorf("resolved account %s, want the credential's owner %s", got, targetID)
	}
	if !bytes.Equal(user.WebAuthnID(), []byte(sourceID)) {
		t.Errorf("WebAuthnID = %q, want the registered handle %q", user.WebAuthnID(), sourceID)
	}
}

// TestUndecodablePasskeyIsAFailure ([D-191]): a credential_json that does not
// decode fails the load, so sign-in answers 500 instead of a misleading
// "verification failed" for a passkey quietly left out.
func TestUndecodablePasskeyIsAFailure(t *testing.T) {
	app := testutil.NewApp(t)
	acct, _ := testutil.CreateAccount(t, app, "Anna")
	cred := testutil.CreateCredential(t, app, acct)
	cred.Set("credential_json", "[1,2]")
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatal(err)
	}
	if creds, err := loadCredentials(app, acct); err == nil {
		t.Errorf("loadCredentials = %v, nil; want the decode error", creds)
	}
}
