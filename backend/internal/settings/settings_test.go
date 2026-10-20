package settings

import (
	"slices"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/fieldcontract"
)

// [D-61] Unset and blank keep the default; a set value is taken.
func TestReadServe(t *testing.T) {
	t.Setenv("SHOPPINGLIST_ADMIN_UI", "  ")
	t.Setenv("SHOPPINGLIST_SCANNER", "OFF")
	t.Setenv("SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT", " 7 ")
	s, err := ReadServe()
	if err != nil {
		t.Fatal(err)
	}
	if !s.AdminUI || s.Scanner || s.MaxListsPerAccount != 7 || s.Signup != "open" || s.OIDC != nil {
		t.Errorf("read %+v", s)
	}
}

// A switch whose absence means something stays nil until set, blank included.
func TestUnsetSwitch(t *testing.T) {
	t.Setenv("SHOPPINGLIST_OIDC", " ")
	if s, _ := ReadServe(); s.OIDC != nil {
		t.Errorf("blank SHOPPINGLIST_OIDC read as %v, want unset", *s.OIDC)
	}
	t.Setenv("SHOPPINGLIST_OIDC", "off")
	if s, _ := ReadServe(); s.OIDC == nil || bool(*s.OIDC) {
		t.Errorf("SHOPPINGLIST_OIDC=off read as %v", s.OIDC)
	}
}

// Every refusal names its variable, all at once, as the boot prints them.
func TestRefusalsNameTheVariable(t *testing.T) {
	t.Setenv("SHOPPINGLIST_ADMIN_UI", "Maybe")
	t.Setenv("SHOPPINGLIST_OIDC", "yes")
	t.Setenv("SHOPPINGLIST_MAX_ITEMS_PER_LIST", "0")
	_, err := ReadServe()
	for _, want := range []string{
		`SHOPPINGLIST_ADMIN_UI ("maybe") must be "on" or "off"`,
		`SHOPPINGLIST_OIDC ("yes") must be "on" or "off"`,
		`SHOPPINGLIST_MAX_ITEMS_PER_LIST ("0") must be a whole number >= 1 (items per list)`,
	} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("error %v, want it to say %s", err, want)
		}
	}
}

// The items cap's default is the contract the client reads too.
func TestItemsDefaultIsTheContract(t *testing.T) {
	if got := int(ServeDefaults().MaxItemsPerList); got != fieldcontract.MaxItemsPerList() {
		t.Errorf("default %d, contract %d", got, fieldcontract.MaxItemsPerList())
	}
}

func TestNames(t *testing.T) {
	names := Names()
	for _, want := range []string{"SHOPPINGLIST_RP_ID", "SHOPPINGLIST_OIDC_ISSUER", "SQLITE_PRAGMAS", "SHOPPINGLIST_DEMO_MAX_ACCOUNTS"} {
		if !slices.Contains(names, want) {
			t.Errorf("Names() lacks %s: %v", want, names)
		}
	}
}

// SHOPPINGLIST_APP_URL's documented default is PocketBase's own: the server
// sets nothing while it is unset.
func TestAppURLDefaultIsPocketBases(t *testing.T) {
	b, docs := Boot{}, fieldDocs(t)
	_, def := splitDefault(docs["Boot.AppURL"])
	pb := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	if want := "`" + pb.Settings().Meta.AppURL + "`"; def != want || b.AppURL != "" {
		t.Errorf("the docs say %s, PocketBase defaults to %s", def, want)
	}
}
