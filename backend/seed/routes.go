package seed

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/security"
)

// RegisterRoutes mounts GET /api/seed-version (§6.12): the embedded seed's
// version, which the client compares with its cached reference data's.
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent]) {
	security.AuthRoutes(router).GET("/api/seed-version", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]any{"version": CurrentSeedVersion})
	})
}
