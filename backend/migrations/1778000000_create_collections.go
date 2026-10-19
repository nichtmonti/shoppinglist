// Package migrations holds the shoppinglist Go migrations (docs/internals/design.md §6, §11).
// Registered into core.AppMigrations via the PocketBase migrations.Register
// helper; applied by app.RunAllMigrations() (called from apis.Serve and tests).
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	pbmigrations.Register(createCollectionsUp, createCollectionsDown, "1778000000_create_collections.go")
}

func createCollectionsUp(app core.App) error {
	// --- accounts (auth) ---------------------------------------------------
	accounts := core.NewAuthCollection("accounts")
	accounts.PasswordAuth.Enabled = false // passkey-only; login via §5.4 routes. OAuth2 stays DISABLED here — [D-76]: oidc.Apply enables it + seeds the provider only when SHOPPINGLIST_OIDC_* is set, so deployments without the env keep the auth-with-oauth2 route 404ing.
	accounts.OAuth2.Enabled = false
	accounts.AuthToken.Duration = 90 * 24 * 60 * 60 // 90-day auth tokens (docs/internals/design.md §5.6)
	// PocketBase's auth email field is unused (§6.1, [D-25]: no account holds
	// an address). It is Required by default; relax it. SQLite UNIQUE allows multiple NULLs.
	if ef, ok := accounts.Fields.GetByName(core.FieldNameEmail).(*core.EmailField); ok {
		ef.Required = false
		accounts.Fields.Add(ef)
	}
	accounts.Fields.Add(
		// Optional ([D-76]): PocketBase's OAuth2 auto-create runs the FULL
		// record-create pipeline (apis.sendOAuth2RecordCreateRequest → internal
		// POST /api/collections/accounts/records), so a required handle would
		// reject every first OIDC login. Passkey registration keeps generating
		// one server-side; OIDC-born accounts have a null handle (§5.9). The
		// unique index below is unique-when-set — SQLite allows multiple NULLs.
		&core.TextField{Name: "handle"},
		&core.TextField{Name: "nickname"},
	)
	accounts.Indexes = types.JSONArray[string]{`CREATE UNIQUE INDEX ` + "`idx_accounts_handle`" + ` ON ` + "`accounts`" + ` (` + "`handle`" + `)`}
	accounts.ListRule = new("id = @request.auth.id")
	accounts.ViewRule = new("id = @request.auth.id")
	// create/update/delete: nil (passkey routes / account-deletion route only)
	addTimestamps(accounts)
	if err := app.Save(accounts); err != nil {
		return err
	}

	// --- credentials -------------------------------------------------------
	credentials := core.NewBaseCollection("credentials")
	credentials.Fields.Add(
		&core.RelationField{Name: "account", Required: true, MaxSelect: 1, CollectionId: accounts.Id, CascadeDelete: true},
		&core.TextField{Name: "credential_id", Required: true},
		&core.JSONField{Name: "credential_json", Required: true},
		&core.TextField{Name: "friendly_name"},
		&core.DateField{Name: "last_used_at"},
	)
	credentials.Indexes = types.JSONArray[string]{`CREATE UNIQUE INDEX ` + "`idx_credentials_credential_id`" + ` ON ` + "`credentials`" + ` (` + "`credential_id`" + `)`}
	credentials.ListRule = new("account = @request.auth.id")
	credentials.ViewRule = new("account = @request.auth.id")
	credentials.UpdateRule = new("account = @request.auth.id")
	// Go guard: account.credentialsDeleteGuard (internal/account/guard.go)
	// refuses an account's last passkey on top of this rule ([D-32]).
	credentials.DeleteRule = new("account = @request.auth.id")
	addTimestamps(credentials)
	if err := app.Save(credentials); err != nil {
		return err
	}

	// --- webauthn_sessions (ephemeral, server-only) -----------------------
	webauthnSessions := core.NewBaseCollection("webauthn_sessions")
	webauthnSessions.Fields.Add(
		&core.TextField{Name: "browser_id"},
		&core.JSONField{Name: "session_data", Required: true},
		&core.TextField{Name: "type"},
		&core.RelationField{Name: "account", MaxSelect: 1, CollectionId: accounts.Id},
		&core.DateField{Name: "expires_at"},
	)
	// all rules nil (server-managed, never exposed to clients)
	addTimestamps(webauthnSessions)
	if err := app.Save(webauthnSessions); err != nil {
		return err
	}

	// --- lists (no name, no owner, no tombstone; §6.4) --------------------
	// NOTE: ListRule references @collection.memberships, but memberships cannot
	// exist until lists does (memberships.list -> lists). The rule is set after
	// memberships is created, at the end of this migration.
	lists := core.NewBaseCollection("lists")
	addTimestamps(lists)
	if err := app.Save(lists); err != nil {
		return err
	}

	// --- memberships (no tombstone; leave = hard delete) -------------------
	memberships := core.NewBaseCollection("memberships")
	memberships.Fields.Add(
		// non-cascading: deleted by the account-deletion route, not an implicit cascade
		&core.RelationField{Name: "account", Required: true, MaxSelect: 1, CollectionId: accounts.Id, CascadeDelete: false},
		&core.RelationField{Name: "list", Required: true, MaxSelect: 1, CollectionId: lists.Id},
		&core.TextField{Name: "display_name"},
	)
	memberships.Indexes = types.JSONArray[string]{`CREATE UNIQUE INDEX ` + "`idx_memberships_account_list`" + ` ON ` + "`memberships`" + ` (` + "`account`" + `, ` + "`list`" + `)`}
	memberships.ListRule = new("account = @request.auth.id")
	memberships.ViewRule = new("account = @request.auth.id")
	memberships.UpdateRule = new("account = @request.auth.id")
	memberships.DeleteRule = new("account = @request.auth.id")
	addTimestamps(memberships)
	if err := app.Save(memberships); err != nil {
		return err
	}

	// --- items (syncable; all writes via sync push) -----------------------
	items := core.NewBaseCollection("items")
	items.Fields.Add(
		&core.RelationField{Name: "list", Required: true, MaxSelect: 1, CollectionId: lists.Id},
		&core.TextField{Name: "name", Required: true},
		&core.TextField{Name: "quantity"},
		&core.TextField{Name: "note"},
		&core.TextField{Name: "category_key"},
		&core.BoolField{Name: "checked"},
		&core.DateField{Name: "checked_at"},
		&core.DateField{Name: "last_bought_at"},
		&core.TextField{Name: "barcode"},
		&core.TextField{Name: "image_url"},
		// non-cascading (§6.6 [D-32]); sync-push stamps modified_by
		&core.RelationField{Name: "modified_by", MaxSelect: 1, CollectionId: accounts.Id, CascadeDelete: false},
		&core.DateField{Name: "deleted_at"},
	)
	items.ListRule = new(membershipRule("list.id"))
	items.ViewRule = items.ListRule
	addTimestamps(items)
	if err := app.Save(items); err != nil {
		return err
	}

	// --- category_templates (global, app-seeded, read-only to clients) ----
	categoryTemplates := core.NewBaseCollection("category_templates")
	categoryTemplates.Fields.Add(
		&core.TextField{Name: "slug", Required: true},
		&core.JSONField{Name: "name_i18n", Required: true},
		&core.TextField{Name: "icon"},
		&core.TextField{Name: "color"},
		&core.NumberField{Name: "sort_order", OnlyInt: true},
	)
	categoryTemplates.Indexes = types.JSONArray[string]{`CREATE UNIQUE INDEX ` + "`idx_category_templates_slug`" + ` ON ` + "`category_templates`" + ` (` + "`slug`" + `)`}
	// authenticated read; writes superuser-only (nil)
	categoryTemplates.ListRule = new("@request.auth.id != ''")
	categoryTemplates.ViewRule = new("@request.auth.id != ''")
	addTimestamps(categoryTemplates)
	if err := app.Save(categoryTemplates); err != nil {
		return err
	}

	// --- list_categories (per-list, syncable) -----------------------------
	listCategories := core.NewBaseCollection("list_categories")
	listCategories.Fields.Add(
		&core.RelationField{Name: "list", Required: true, MaxSelect: 1, CollectionId: lists.Id},
		&core.TextField{Name: "slug"},
		&core.TextField{Name: "name"},
		&core.TextField{Name: "icon"},
		&core.TextField{Name: "color"},
		&core.NumberField{Name: "sort_order", OnlyInt: true},
		&core.DateField{Name: "deleted_at"},
	)
	listCategories.ListRule = new(membershipRule("list.id"))
	listCategories.ViewRule = listCategories.ListRule
	addTimestamps(listCategories)
	if err := app.Save(listCategories); err != nil {
		return err
	}

	// --- invites -----------------------------------------------------------
	invites := core.NewBaseCollection("invites")
	invites.Fields.Add(
		&core.RelationField{Name: "list", Required: true, MaxSelect: 1, CollectionId: lists.Id},
		&core.TextField{Name: "token_hash", Required: true},
		&core.TextField{Name: "display_name"},
		&core.DateField{Name: "expires_at"},
		&core.BoolField{Name: "revoked"},
		// non-cascading (§6.8 [D-32])
		&core.RelationField{Name: "created_by", MaxSelect: 1, CollectionId: accounts.Id, CascadeDelete: false},
	)
	invites.Indexes = types.JSONArray[string]{`CREATE UNIQUE INDEX ` + "`idx_invites_token_hash`" + ` ON ` + "`invites`" + ` (` + "`token_hash`" + `)`}
	invites.ListRule = new(membershipRule("list.id"))
	invites.ViewRule = invites.ListRule
	// Both nil since migration 1778000007; the routes in
	// internal/invites/manage.go took them over ([D-31]).
	invites.CreateRule = new(membershipRule("list.id"))
	invites.UpdateRule = new(membershipRule("list.id"))
	addTimestamps(invites)
	if err := app.Save(invites); err != nil {
		return err
	}

	// --- item_dictionary (global, app-seeded, read-only to clients) -------
	itemDictionary := core.NewBaseCollection("item_dictionary")
	itemDictionary.Fields.Add(
		&core.JSONField{Name: "names_i18n", Required: true},
		&core.TextField{Name: "default_category"},
		&core.NumberField{Name: "popularity", OnlyInt: true},
	)
	itemDictionary.ListRule = new("@request.auth.id != ''")
	itemDictionary.ViewRule = new("@request.auth.id != ''")
	addTimestamps(itemDictionary)
	if err := app.Save(itemDictionary); err != nil {
		return err
	}

	// --- deferred: lists.ListRule now that memberships exists -------------
	lists.ListRule = new(membershipRule("id"))
	lists.ViewRule = lists.ListRule
	return app.Save(lists)
}

func createCollectionsDown(app core.App) error {
	for _, name := range []string{
		"item_dictionary",
		"invites",
		"list_categories",
		"category_templates",
		"items",
		"memberships",
		"lists",
		"webauthn_sessions",
		"credentials",
		"accounts",
	} {
		if col, _ := app.FindCollectionByNameOrId(name); col != nil {
			if err := app.Delete(col); err != nil {
				return err
			}
		}
	}
	return nil
}
