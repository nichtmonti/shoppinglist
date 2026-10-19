package lists

import (
	"net/http"
	"testing"

	"shoppinglist/internal/testutil"
)

// The §10 budgets for the list routes.
//
// AuthRoutes bounds WHO may call these, never how often, and PocketBase's own
// /api/ catch-all is a single budget shared by every route and every purpose —
// so until these were added, "authenticated" was the only thing between one
// member and unbounded server-side state. import and clone carry the tightest
// numbers in the table because one call writes thousands of rows.
//
// Each case spends its own budget to exhaustion. testutil.NewMux re-arms every
// limiter per test router, so they cannot poison one another, nor the suites
// that merely use these routes.

func TestListRouteRateLimits(t *testing.T) {
	cases := []struct {
		name  string
		quota int
		call  func(t *testing.T, mux http.Handler, tok string) int
	}{
		{"create", 30, func(t *testing.T, mux http.Handler, tok string) int {
			rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/lists",
				`{"name":"Einkauf"}`, testutil.AuthHeader(tok))
			return rec.Code
		}},
		{"import", 10, func(t *testing.T, mux http.Handler, tok string) int {
			rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/lists/import",
				importBody(t, "Restored", validBackup()), testutil.AuthHeader(tok))
			return rec.Code
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Anna")

			for i := 0; i < tc.quota; i++ {
				if code := tc.call(t, mux, tok); code == http.StatusTooManyRequests {
					t.Fatalf("attempt %d of %d: rate-limited too early", i+1, tc.quota)
				}
			}
			if code := tc.call(t, mux, tok); code != http.StatusTooManyRequests {
				t.Errorf("attempt %d status = %d, want 429", tc.quota+1, code)
			}
		})
	}
}

// The list-scoped routes need a membership before the limiter is reached, so
// they set their own source list up rather than joining the table above.
func TestListScopedRouteRateLimits(t *testing.T) {
	cases := []struct {
		name, path string
		quota      int
	}{
		{"clone", "/clone", 10},
		{"clear-history", "/clear-history", 30},
		{"missing-categories", "/categories/missing", 30},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app, mux := setupListsApp(t)
			acctID, tok := testutil.CreateAccount(t, app, "Anna")
			listID := testutil.CreateList(t, app, "")
			testutil.AddMembership(t, app, acctID, listID)

			call := func() int {
				rec, _ := testutil.DoReq(mux, http.MethodPost,
					"/api/lists/"+listID+tc.path, `{}`, testutil.AuthHeader(tok))
				return rec.Code
			}
			for i := 0; i < tc.quota; i++ {
				if code := call(); code == http.StatusTooManyRequests {
					t.Fatalf("attempt %d of %d: rate-limited too early", i+1, tc.quota)
				}
			}
			if code := call(); code != http.StatusTooManyRequests {
				t.Errorf("attempt %d status = %d, want 429", tc.quota+1, code)
			}
		})
	}
}

// The roster is deliberately UNMETERED: a read, refreshed on every share-sheet
// open (§7.4). Pinned so a later pass that "finishes the table" has to argue
// with a test rather than with a comment.
func TestRosterIsNotRateLimited(t *testing.T) {
	app, mux := setupListsApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Anna")
	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, acctID, listID)

	for i := range 60 {
		rec, body := testutil.DoReq(mux, http.MethodGet,
			"/api/lists/"+listID+"/members", "", testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Fatalf("roster read %d = %d, want 200 (no budget belongs on a read): %s",
				i+1, rec.Code, body)
		}
	}
}
