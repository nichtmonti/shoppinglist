// External test package (package security_test, not security): these two
// files drive real routers through internal/testutil, which imports
// security — an in-package test file importing it would be an import cycle. Both files only ever exercise exported API, which is the
// reason they can move and headers_test.go/admin_test.go cannot.
package security_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// setupListGuardApp mounts a minimal list-scoped route on MemberRoutes, as
// lists.RegisterRoutes mounts the roster.
func setupListGuardApp(t *testing.T) (core.App, http.Handler) {
	t.Helper()
	app := testutil.NewApp(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	ok := func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]string{"ok": "true"})
	}
	security.MemberRoutes(router.RouterGroup).POST("/api/test/{listId}", ok)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return app, mux
}

// TestMemberRoutes [D-74]: the gate admits a member, rejects an
// authenticated non-member and a nonexistent list with byte-identical 403s
// (no list-existence leak), and rejects an unauthenticated caller with 401.
func TestMemberRoutes(t *testing.T) {
	app, mux := setupListGuardApp(t)
	aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")
	_, bobTok := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, aliceID, "")

	// (a) member on her own list.
	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/test/"+listID, "", testutil.AuthHeader(aliceTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("member request = %d, want 200: %s", rec.Code, body)
	}

	// (b) authenticated non-member.
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/test/"+listID, "", testutil.AuthHeader(bobTok))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-member request = %d, want 403: %s", rec.Code, body)
	}
	var errBody struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &errBody); err != nil {
		t.Fatalf("non-member body is not JSON: %v: %s", err, body)
	}
	// PocketBase renders the message capitalized with a trailing period;
	// compare case-insensitively with the period trimmed.
	if got := strings.TrimSuffix(strings.ToLower(errBody.Message), "."); got != "not a member of this list" {
		t.Errorf("non-member message = %q, want %q: %s", got, "not a member of this list", body)
	}
	nonMemberBody := body

	// (c) member on a nonexistent list — response must be byte-identical to
	// (b), or the route leaks list existence.
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/test/"+randid.ID(), "", testutil.AuthHeader(aliceTok))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("nonexistent-list request = %d, want 403: %s", rec.Code, body)
	}
	if body != nonMemberBody {
		t.Errorf("nonexistent-list body %q != non-member body %q (list existence leaked)", body, nonMemberBody)
	}

	// (d) no Authorization header at all.
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/test/"+listID, "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request = %d, want 401: %s", rec.Code, body)
	}
}

// countFailApp fails every CountRecords: the membership check cannot run.
type countFailApp struct{ core.App }

func (countFailApp) CountRecords(any, ...dbx.Expression) (int64, error) {
	return 0, errors.New("injected count failure")
}

// A failed membership lookup is a server error, not a 403: the client treats a
// 403 as "you lost this list".
func TestCheckListMembershipLookupFailureIs500(t *testing.T) {
	app := testutil.NewApp(t)
	acct, _ := testutil.CreateAccount(t, app, "Alice")
	rec, err := app.FindRecordById("accounts", acct)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/test/l1", nil)
	req.SetPathValue("listId", "l1")
	e := &core.RequestEvent{Auth: rec}
	e.App = countFailApp{app}
	e.Request = req
	e.Response = httptest.NewRecorder()

	var apiErr *router.ApiError
	if err := security.CheckListMembership(e.App, e); !errors.As(err, &apiErr) || apiErr.Status != http.StatusInternalServerError {
		t.Errorf("err = %v, want a 500", err)
	}
}
