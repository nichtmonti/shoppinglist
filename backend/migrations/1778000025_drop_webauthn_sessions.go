// Migration 1778000025 — the webauthn_sessions collection goes: a passkey
// ceremony's session is held in memory between its begin and its finish
// ([D-03], internal/webauthn). The rows it held were valid for five minutes.
// Down is a no-op.

package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	pbmigrations "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	pbmigrations.Register(dropWebauthnSessionsUp, func(core.App) error { return nil }, "1778000025_drop_webauthn_sessions.go")
}

func dropWebauthnSessionsUp(app core.App) error {
	col, err := app.FindCollectionByNameOrId("webauthn_sessions")
	if err != nil {
		return nil // never created
	}
	return app.Delete(col)
}
