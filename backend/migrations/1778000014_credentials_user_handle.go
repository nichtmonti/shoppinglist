package migrations

// [D-153]: a passkey keeps the WebAuthn user handle it was registered under.
//
// The authenticator stores the user handle (user.id) with the credential at
// registration and returns it on every assertion; the WebAuthn spec makes it
// immutable. It was the owning account's id, and passkey login required the
// two to match — so when the §5.9 [D-76] link moved a passkey account's
// credentials to the OIDC account, every moved passkey failed login/finish
// with a 400: its authenticator still names the deleted source account.
//
// The credential row now records the handle itself. Backfilled with the
// current owner, which is what every credential that was never moved was
// registered under. Hidden: it is server bookkeeping, not client data.

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(credentialsUserHandleUp, credentialsUserHandleDown,
		"1778000014_credentials_user_handle.go")
}

func credentialsUserHandleUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("credentials")
	if err != nil {
		return err
	}
	col.Fields.Add(&core.TextField{Name: "user_handle", Hidden: true, Max: 64})
	if err := app.Save(col); err != nil {
		return err
	}
	_, err = app.DB().NewQuery("UPDATE credentials SET user_handle = account WHERE user_handle = ''").Execute()
	return err
}

func credentialsUserHandleDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("credentials")
	if err != nil {
		return err
	}
	col.Fields.RemoveByName("user_handle")
	return app.Save(col)
}
