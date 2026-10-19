package webauthn

import (
	"fmt"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// accountUser adapts an accounts record and its passkeys to webauthn.User
// (§5.2). WebAuthnID is the account's record id, the userHandle embedded at
// registration.
type accountUser struct {
	record      *core.Record
	credentials []webauthn.Credential
	// handle overrides WebAuthnID for a login: the user handle the asserted
	// credential was registered under, which differs from the account id once
	// the [D-76] link has moved the credential to another account ([D-153]).
	handle string
}

func newAccountUser(rec *core.Record, creds []webauthn.Credential) *accountUser {
	return &accountUser{record: rec, credentials: creds}
}

func (u *accountUser) WebAuthnID() []byte {
	if u.handle != "" {
		return []byte(u.handle)
	}
	return []byte(u.record.Id)
}

// WebAuthnName is the label a passkey manager shows: the nickname, not the
// hex handle. Display only; identity is WebAuthnID ([D-02]).
func (u *accountUser) WebAuthnName() string {
	if nick := u.record.GetString("nickname"); nick != "" {
		return nick
	}
	return u.record.GetString("handle")
}

func (u *accountUser) WebAuthnDisplayName() string                { return u.record.GetString("nickname") }
func (u *accountUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

// loadCredentials returns all passkeys for the account, deserialised from the
// lossless credential_json blob (§6.2). A blob that does not decode is a
// failure, not a passkey that is not there ([D-191]).
func loadCredentials(app core.App, accountID string) ([]webauthn.Credential, error) {
	recs, err := app.FindAllRecords("credentials", dbx.HashExp{"account": accountID})
	if err != nil {
		return nil, err
	}
	out := make([]webauthn.Credential, 0, len(recs))
	for _, r := range recs {
		var c webauthn.Credential
		if err := r.UnmarshalJSONField("credential_json", &c); err != nil {
			return nil, fmt.Errorf("credential %s: %w", r.Id, err)
		}
		out = append(out, c)
	}
	return out, nil
}
