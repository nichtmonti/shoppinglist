// Package security holds the app-wide §10 protections that do not belong to
// any single feature route:
//
//   - the response headers every request carries, Content-Security-Policy
//     included (headers.go);
//   - the route groups that guard custom routes: AuthRoutes and the
//     list-scoped MemberRoutes (guard.go, listguard.go);
//   - the per-IP rate-limit budgets and their table (ratelimit.go);
//   - the remote-administration lockdown, SHOPPINGLIST_ADMIN_UI (admin.go).
package security
