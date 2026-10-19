package oidc

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// TestWarnStrandedAccounts ([D-76]): each switched-off method names how many
// accounts depend on it alone.
func TestWarnStrandedAccounts(t *testing.T) {
	app := testutil.NewApp(t)
	passkeyOnly, _ := testutil.CreateAccount(t, app, "Anna")
	oidcOnly, _ := testutil.CreateAccount(t, app, "Bob")
	accounts, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts: %v", err)
	}
	link := core.NewExternalAuth(app)
	link.SetCollectionRef(accounts.Id)
	link.SetRecordRef(oidcOnly)
	link.SetProvider("oidc")
	link.SetProviderId("bob")
	if err := app.Save(link); err != nil {
		t.Fatalf("save external auth: %v", err)
	}
	creds, err := app.FindCollectionByNameOrId("credentials")
	if err != nil {
		t.Fatalf("find credentials: %v", err)
	}
	cred := core.NewRecord(creds)
	cred.Set("account", passkeyOnly)
	cred.Set("credential_id", "cred-anna")
	cred.Set("public_key", "pk")
	if err := app.SaveNoValidate(cred); err != nil {
		t.Fatalf("save credential: %v", err)
	}

	for _, tc := range []struct {
		name           string
		passkeys, oidc bool
		want           string
	}{
		{"both on", true, true, ""},
		{"passkeys off", false, true, "1 account(s) have no OIDC login"},
		{"oidc off", true, false, "1 account(s) have no passkey"},
	} {
		buf := testutil.CaptureLog(t)
		if err := WarnStrandedAccounts(app, tc.passkeys, tc.oidc); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		got := buf.String()
		if tc.want == "" && got != "" || tc.want != "" && !strings.Contains(got, tc.want) {
			t.Errorf("%s: log = %q, want %q", tc.name, got, tc.want)
		}
	}
}
