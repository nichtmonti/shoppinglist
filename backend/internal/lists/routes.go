// Package lists implements the §7.4/§7.5 list-management routes and the rule
// on a list's one member-writable column:
//
//   - POST /api/lists creates a list with the creator's membership and a
//     per-list copy of the global category_templates seed (create.go);
//   - POST /api/lists/{listId}/clone copies a list the caller belongs to
//     [D-72] (clone.go);
//   - POST /api/lists/import restores a per-list backup document [D-72]
//     (import.go);
//   - POST /api/lists/{listId}/clear-history forgets the list's purchase
//     dates [D-79] (clearhistory.go);
//   - POST /api/lists/{listId}/categories/missing adds the template
//     categories the list has no row for [D-251] (missingcategories.go);
//   - GET /api/lists/{listId}/members is the member roster (roster.go);
//   - a hook bounds a member's rename of the list ([D-08], guard.go);
//   - the §7.3 departure hook revokes the link, and the last member's deletes
//     the list (cascade.go).
//
// The three creating routes share one transaction, populateList
// (populate.go). Every list id is minted by the server ([D-08]).
package lists

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/security"
)

// handlers are the routes that read the deployment's caps.
type handlers struct{ caps listcap.Caps }

// RegisterRoutes mounts the §7.4/§7.5 list routes on the serve router.
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent], caps listcap.Caps) {
	h := handlers{caps}
	auth := security.AuthRoutes(router)
	auth.POST("/api/lists", h.createList).BindFunc(security.RateLimit(security.RateListCreate))
	// not a member route: import has no source list [D-72/D-74]
	auth.POST("/api/lists/import", h.importList).Bind(security.LargeBody()).
		BindFunc(security.RateLimit(security.RateListImport))

	member := security.MemberRoutes(router)
	// roster is a READ, refreshed on every share-sheet open (§7.4) — no budget
	// of its own on purpose; see internal/security/ratelimit.go.
	member.GET("/api/lists/{listId}/members", roster)
	member.POST("/api/lists/{listId}/clone", h.cloneList).BindFunc(security.RateLimit(security.RateListClone))
	member.POST("/api/lists/{listId}/clear-history", clearHistory).
		BindFunc(security.RateLimit(security.RateClearHistory))
	member.POST("/api/lists/{listId}/categories/missing", addMissingCategories).
		BindFunc(security.RateLimit(security.RateMissingCategories))
}
