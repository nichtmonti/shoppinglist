package sync

import (
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/security"
)

// RegisterRoutes mounts the §8 sync routes on the serve router.
//
// The two read routes answer compressed when the client asks: a long list's
// snapshot is megabytes of JSON that gzip shrinks about twelvefold. Only
// these: they carry no secret beside text a caller chose (BREACH), and the
// other app routes are small, or photos that do not shrink.
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent], caps listcap.Caps) {
	gzip := apis.GzipWithConfig(apis.GzipConfig{MinLength: 1 << 10})
	auth := security.AuthRoutes(router)
	auth.POST("/api/sync/push", pushHandler(caps.Items)).Bind(security.LargeBody()).BindFunc(security.RateLimit(security.RateSyncPush))
	auth.GET("/api/sync/digest", digestHandler).Bind(gzip)
	security.MemberRoutes(router).GET("/api/sync/snapshot/{listId}", snapshotHandler).Bind(gzip)
}
