package migrations

// This migration sets accounts.UpdateRule so account owners may attempt a
// direct update to their own row; the internal/account.Register hook then
// enforces the §11 field allowlist (only nickname passes through) on top.

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(accountsUpdateRuleUp, accountsUpdateRuleDown, "1778000001_accounts_update_rule.go")
}

func accountsUpdateRuleUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	// Narrowed by account.accountsUpdateGuard (internal/account/guard.go).
	col.UpdateRule = new("id = @request.auth.id")
	return app.Save(col)
}

func accountsUpdateRuleDown(app core.App) error {
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		return err
	}
	col.UpdateRule = nil
	return app.Save(col)
}
