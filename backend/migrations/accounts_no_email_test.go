package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func saveAccount(t *testing.T, app *pocketbase.PocketBase, id, handle, email string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Id = id
	rec.Set("handle", handle)
	rec.Set("nickname", id)
	rec.SetEmail(email)
	rec.SetRandomPassword()
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save account %s: %v", id, err)
	}
	return rec
}

// TestClearAccountEmails ([D-25]): every stored address is cleared, the old
// hook's orphans (no handle, never signed into) are removed, and every account
// someone can sign into survives.
func TestClearAccountEmails(t *testing.T) {
	app := newMigratedApp(t)

	oidcAcct := saveAccount(t, app, "oidcaccountaaaa", "", "anna@example.com")
	link := core.NewExternalAuth(app)
	link.SetCollectionRef(oidcAcct.Collection().Id)
	link.SetRecordRef(oidcAcct.Id)
	link.SetProvider("oidc")
	link.SetProviderId("stub-1")
	if err := app.Save(link); err != nil {
		t.Fatalf("save external auth: %v", err)
	}
	saveAccount(t, app, "passkeyaccountb", "somehandle", "")
	saveAccount(t, app, "orphanaccountcc", "", "orphan@example.com")

	if err := clearAccountEmails(app); err != nil {
		t.Fatalf("clearAccountEmails: %v", err)
	}

	for _, id := range []string{"oidcaccountaaaa", "passkeyaccountb"} {
		rec, err := app.FindRecordById("accounts", id)
		if err != nil {
			t.Fatalf("account %s removed: %v", id, err)
		}
		if rec.Email() != "" {
			t.Errorf("account %s kept email %q", id, rec.Email())
		}
	}
	if _, err := app.FindRecordById("accounts", "orphanaccountcc"); err == nil {
		t.Error("orphan survived")
	}
}
