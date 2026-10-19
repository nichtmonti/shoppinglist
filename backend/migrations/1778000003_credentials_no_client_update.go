package migrations

// Drop credentials.UpdateRule entirely.
//
// PocketBase evaluates an UpdateRule ONLY as a filter on the PRE-update row
// (apis/record_crud.go: the rule is applied to the "refetch with access
// checks" query, and nothing re-checks the post-update state). So a rule of
// "account = @request.auth.id" means "you may edit a row you currently own" —
// NOT "the row must still be yours afterwards". A client could therefore PATCH
// its own credentials row and set `account` to any other account id, grafting
// its passkey onto someone else's account.
//
// With a login that trusts the client-supplied `response.userHandle` (which is
// not covered by the WebAuthn signature), that is a full account takeover:
// go-webauthn's validateLogin only requires that the asserted credential
// appear in THAT account's credential list, and a reparented credential
// satisfies it. (internal/webauthn's resolveUserFromCredential closes the
// login side as well.)
//
// The client never updates credentials at all (frontend reads them for the
// passkey list and deletes them to remove a passkey — src/lib/actions/account.ts),
// so no rule is needed. Delete stays client-allowed, guarded by
// internal/account.credentialsDeleteGuard. Renaming a passkey (friendly_name)
// goes through its own route (internal/account/rename_credential.go), not a
// blanket update rule.

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(credentialsNoClientUpdateUp, credentialsNoClientUpdateDown, "1778000003_credentials_no_client_update.go")
}

func credentialsNoClientUpdateUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("credentials")
	if err != nil {
		return err
	}
	col.UpdateRule = nil // superuser-only
	return app.Save(col)
}

func credentialsNoClientUpdateDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("credentials")
	if err != nil {
		return err
	}
	col.UpdateRule = new("account = @request.auth.id")
	return app.Save(col)
}
