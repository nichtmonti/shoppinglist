// Package testapp boots the throwaway PocketBase app every backend test runs
// against. It is testutil's leaf: testutil imports security and seed (for
// NewMux), so their own tests cannot import testutil, but they can import
// this.
package testapp

import (
	"testing"

	"github.com/pocketbase/pocketbase"

	_ "shoppinglist/migrations" // register collection migrations for RunAllMigrations
)

// New bootstraps a temp-dir PocketBase app with all migrations applied.
func New(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return app
}
