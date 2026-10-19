package migrations

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestCollectionsCreated(t *testing.T) {
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	want := []string{
		"accounts", "credentials", "lists", "memberships",
		"items", "category_templates", "list_categories", "invites", "item_dictionary", "oidc_identities",
	}
	for _, name := range want {
		if col, _ := app.FindCollectionByNameOrId(name); col == nil {
			t.Errorf("collection %q was not created", name)
		}
	}

	// unique indexes must be present
	indexChecks := []struct {
		collection string
		substr     string
	}{
		{"credentials", "`credential_id`"},
		{"memberships", "`account`"},
		{"memberships", "`list`"},
		{"category_templates", "`slug`"},
		{"invites", "`token_hash`"},
		{"accounts", "`handle`"},
	}
	for _, c := range indexChecks {
		col, _ := app.FindCollectionByNameOrId(c.collection)
		if col == nil {
			t.Fatalf("collection %q missing for index check", c.collection)
		}
		found := false
		for _, idx := range col.Indexes {
			if strings.Contains(idx, "UNIQUE") && strings.Contains(idx, c.substr) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("collection %q: no UNIQUE index containing %q (indexes=%v)", c.collection, c.substr, col.Indexes)
		}
	}

	// [1778000009] the digest's list_categories half must be indexed: digest.go
	// selects `WHERE list = ?` once per membership per cycle — without this the
	// §8.5 probe full-scans per list per device.
	if col, _ := app.FindCollectionByNameOrId("list_categories"); col != nil {
		found := false
		for _, idx := range col.Indexes {
			if strings.Contains(idx, "idx_list_categories_list") {
				found = true
				break
			}
		}
		if !found {
			t.Error("list_categories: idx_list_categories_list missing (digest full-scans without it)")
		}
	}

	// accounts is an auth collection with password auth disabled
	acc, _ := app.FindCollectionByNameOrId("accounts")
	if acc == nil {
		t.Fatal("accounts missing")
	}
	if !acc.IsAuth() {
		t.Error("accounts is not an auth collection")
	}
	if acc.PasswordAuth.Enabled {
		t.Error("accounts password auth should be disabled")
	}
	// [D-76]: OAuth2 is enabled only by oidc.Apply when the operator set
	// SHOPPINGLIST_OIDC_* — a migrated-but-unconfigured instance must not carry
	// the auth-with-oauth2 surface.
	if acc.OAuth2.Enabled {
		t.Error("accounts OAuth2 should be disabled out of the box")
	}
	// handle must be optional ([D-76], §5.9): PB's OAuth2 auto-create runs the
	// full record-create pipeline, so a required handle breaks first OIDC login.
	if hf, ok := acc.Fields.GetByName("handle").(*core.TextField); ok {
		if hf.Required {
			t.Error("accounts handle should be optional (OIDC auto-create)")
		}
	} else {
		t.Error("accounts handle field is missing or not a text field")
	}
	// email must be optional (§6.1)
	if ef, ok := acc.Fields.GetByName("email").(interface{ GetName() string }); ok {
		_ = ef // field exists
	}

	// §10: PocketBase's own limiter must be on out of the box — without it
	// /api/collections/* is unlimited (1778000004_enable_rate_limits.go).
	if !app.Settings().RateLimits.Enabled {
		t.Error("RateLimits.Enabled is false after migrations")
	}
	if len(app.Settings().RateLimits.Rules) == 0 {
		t.Error("RateLimits.Rules is empty — enabling the limiter with no rules limits nothing")
	}

	// [D-334]: a fresh instance backs itself up nightly.
	if b := app.Settings().Backups; b.Cron != backupCron || b.CronMaxKeep != backupKeepLast {
		t.Errorf("Backups = cron %q keep %d, want %q keep %d", b.Cron, b.CronMaxKeep, backupCron, backupKeepLast)
	}

	// [D-03]: ceremony sessions live in memory, so the collection is gone.
	if col, _ := app.FindCollectionByNameOrId("webauthn_sessions"); col != nil {
		t.Error("webauthn_sessions still exists after migrations")
	}
}

// [D-334]: a schedule the operator set before the upgrade stands.
func TestScheduledBackupsKeepAnOperatorsSchedule(t *testing.T) {
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	settings := app.Settings()
	settings.Backups.Cron = "30 1 * * 0"
	settings.Backups.CronMaxKeep = 2
	if err := app.Save(settings); err != nil {
		t.Fatal(err)
	}
	if err := scheduledBackupsUp(app); err != nil {
		t.Fatal(err)
	}
	if b := app.Settings().Backups; b.Cron != "30 1 * * 0" || b.CronMaxKeep != 2 {
		t.Errorf("Backups = cron %q keep %d, want the operator's 30 1 * * 0 keep 2", b.Cron, b.CronMaxKeep)
	}
}
