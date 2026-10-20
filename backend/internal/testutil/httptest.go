package testutil

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/members"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
	"shoppinglist/seed"
)

// NewMux bootstraps a temp app with migrations + the category_templates seed
// applied + the given routes mounted, returning the app and a dispatchable mux.
func NewMux(t *testing.T, register func(r *router.RouterGroup[*core.RequestEvent]), root ...func(*core.RequestEvent) error) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	app := NewApp(t)
	if err := seed.Run(app); err != nil {
		t.Fatalf("seed.Run: %v", err)
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	for _, m := range root {
		router.BindFunc(m)
	}
	register(security.AppRoutes(router))
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return app, mux
}

// CreateAccount saves a bare accounts row directly and returns (id, bearer token).
func CreateAccount(t *testing.T, app core.App, nickname string) (string, string) {
	t.Helper()
	rec := save(t, app, "accounts", func(r *core.Record) {
		r.Set("handle", randid.ID())
		r.Set("nickname", nickname)
		r.SetRandomPassword()
	})
	tok, err := rec.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	return rec.Id, tok
}

// DoReq dispatches an httptest request through mux and returns (recorder, body).
func DoReq(mux http.Handler, method, url, body string, headers map[string]string) (*httptest.ResponseRecorder, string) {
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, url, nil)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec, rec.Body.String()
}

// AuthHeader returns the Authorization header map for a bearer token.
func AuthHeader(tok string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + tok}
}

// LeaveAfterGate is a middleware for a route behind the membership gate: it
// deletes the caller's membership of {listId} before the handler runs, as a
// departure on another device committing between the gate and the handler's
// transaction would (§7.3).
func LeaveAfterGate(e *core.RequestEvent) error {
	m, err := members.Find(e.App, e.Auth.Id, e.Request.PathValue("listId"))
	if err != nil {
		return err
	}
	if err := e.App.Delete(m); err != nil {
		return err
	}
	return e.Next()
}
