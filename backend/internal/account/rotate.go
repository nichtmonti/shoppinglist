package account

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
)

// rotateTokenKey handles POST /api/account/rotate-token-key, §5.6 "log out
// everywhere". Auth tokens are stateless JWTs, so revocation is rotating the
// `tokenKey` that signs them; every token of this account, the caller's own
// included (deliberately), stops verifying.
func rotateTokenKey(e *core.RequestEvent) error {
	// The framework mints the new key on save; never hand-roll it.
	e.Auth.RefreshTokenKey()

	// tokenKey is protected; this route is its one legitimate writer.
	ctx := bypassAccountsUpdateGuard(e.Request.Context())
	if err := e.App.SaveWithContext(ctx, e.Auth); err != nil {
		return e.InternalServerError("failed to rotate token key", err)
	}

	return e.JSON(http.StatusOK, map[string]any{"ok": true})
}
