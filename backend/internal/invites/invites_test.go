package invites

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	pbsecurity "github.com/pocketbase/pocketbase/tools/security"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/testutil"
)

// setupInvitesApp bootstraps a temp app (via testutil.NewApp) with the invite
// routes mounted, returning the app and a dispatchable mux. There are no
// invite hooks to register: invites are written only by the server's
// mint/revoke routes ([D-31]).
func setupInvitesApp(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	return testutil.NewMux(t, RegisterRoutes)
}

// renameList sets the list's one name ([D-08]) directly, as a member's
// rename through lists.UpdateRule would.
func renameList(t *testing.T, app core.App, list *core.Record, name string) {
	t.Helper()
	list.Set("name", name)
	if err := app.SaveNoValidate(list); err != nil {
		t.Fatalf("rename list: %v", err)
	}
}

// newList creates a bare lists row.
func newList(t *testing.T, app core.App) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("lists")
	if err != nil {
		t.Fatalf("find lists collection: %v", err)
	}
	rec := core.NewRecord(col)
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save list: %v", err)
	}
	return rec
}

// newAccount creates an accounts row with a unique handle.
func newAccount(t *testing.T, app core.App, handle string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatalf("find accounts collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("handle", handle)
	rec.SetRandomPassword()
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save account: %v", err)
	}
	return rec
}

// newItem creates an items row on list. If tombstoned, deleted_at is set to a
// non-empty timestamp.
func newItem(t *testing.T, app core.App, list *core.Record, name, quantity string, tombstoned bool) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("list", list.Id)
	rec.Set("name", name)
	rec.Set("quantity", quantity)
	if tombstoned {
		rec.Set("deleted_at", types.NowDateTime())
	}
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save item: %v", err)
	}
	return rec
}

// inviteOpts configures newInvite.
type inviteOpts struct {
	revoked bool
	expired bool
}

// newInvite creates an invites row on list with a known raw token, returning
// the raw token (never stored — only its sha256 hex is) and the record.
func newInvite(t *testing.T, app core.App, list *core.Record, rawToken string, opts inviteOpts) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		t.Fatalf("find invites collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("list", list.Id)
	rec.Set("token_hash", pbsecurity.SHA256(rawToken))
	rec.Set("revoked", opts.revoked)
	if opts.expired {
		past, err := types.ParseDateTime("2020-01-01 10:00:00.000Z")
		if err != nil {
			t.Fatalf("parse past date: %v", err)
		}
		rec.Set("expires_at", past)
	} else {
		future, err := types.ParseDateTime("2099-01-01 10:00:00.000Z")
		if err != nil {
			t.Fatalf("parse future date: %v", err)
		}
		rec.Set("expires_at", future)
	}
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save invite: %v", err)
	}
	return rec
}

// --- preview -----------------------------------------------------------

func TestPreviewHappyPath(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	newAccount(t, app, "inviter1") // member_count seeding via a membership below
	acct := newAccount(t, app, "member1")
	membershipsCol, _ := app.FindCollectionByNameOrId("memberships")
	m := core.NewRecord(membershipsCol)
	m.Set("account", acct.Id)
	m.Set("list", list.Id)
	if err := app.SaveNoValidate(m); err != nil {
		t.Fatalf("save membership: %v", err)
	}

	milk := newItem(t, app, list, "Milk", "2L", false)
	milk.Set("name_de", "Milch") // a scanned item's localized name [D-21]
	if err := app.SaveNoValidate(milk); err != nil {
		t.Fatal(err)
	}
	newItem(t, app, list, "Bread", "1", false)
	newItem(t, app, list, "GoneItem", "1", true) // tombstoned, must be excluded

	renameList(t, app, list, "Family Shopping")
	newInvite(t, app, list, "raw-token-happy", inviteOpts{})

	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"raw-token-happy"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Name        string  `json:"name"`
		DisplayName *string `json:"display_name"`
		Items       []struct {
			Name     string  `json:"name"`
			NameDE   *string `json:"name_de"`
			NameEN   *string `json:"name_en"`
			Quantity string  `json:"quantity"`
		} `json:"items"`
		MemberCount int `json:"member_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v: %s", err, rec.Body.String())
	}
	// The invitee sees the list's own name ([D-08]) — the one every member sees.
	if resp.Name != "Family Shopping" {
		t.Errorf("name = %q, want %q", resp.Name, "Family Shopping")
	}
	if resp.DisplayName != nil {
		t.Errorf("preview still carries the per-member display_name: %q", *resp.DisplayName)
	}
	if len(resp.Items) != 2 {
		t.Fatalf("items count = %d, want 2 (tombstoned excluded): %+v", len(resp.Items), resp.Items)
	}
	for _, it := range resp.Items {
		if it.Name == "GoneItem" {
			t.Errorf("tombstoned item leaked into preview: %+v", it)
		}
		// The invitee sees a scanned item in their own language, as members
		// do; an absent localized name is null, as in the sync rows.
		if it.Name == "Milk" && (it.NameDE == nil || *it.NameDE != "Milch" || it.NameEN != nil) {
			t.Errorf("Milk localized names = %v / %v, want Milch / null", it.NameDE, it.NameEN)
		}
	}
	if resp.MemberCount != 1 {
		t.Errorf("member_count = %d, want 1", resp.MemberCount)
	}
}

// A list with no items previews as an empty array, not null.
func TestPreviewEmptyList(t *testing.T) {
	app, mux := setupInvitesApp(t)
	newInvite(t, app, newList(t, app), "raw-token-empty", inviteOpts{})

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"raw-token-empty"}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(body, `"items":[]`) {
		t.Errorf("preview = %d %s, want 200 with \"items\":[]", rec.Code, body)
	}
}

func TestPreviewUnknownTokenDenied(t *testing.T) {
	_, mux := setupInvitesApp(t)
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"does-not-exist"}`, nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestInviteLookupFailureIsNoRefusal: an invites lookup the database fails is
// a 500, never the 400 that tells the visitor the link is dead ([D-191]).
func TestInviteLookupFailureIsNoRefusal(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	acct := newAccount(t, app, "joiner-fail")
	newInvite(t, app, list, "raw-token-fail", inviteOpts{})
	tok, err := acct.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	if _, err := app.DB().NewQuery("DROP TABLE invites").Execute(); err != nil {
		t.Fatalf("drop invites: %v", err)
	}

	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"raw-token-fail"}`, nil); rec.Code != http.StatusInternalServerError {
		t.Errorf("preview = %d %s, want 500", rec.Code, body)
	}
	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", `{"token":"raw-token-fail"}`, testutil.AuthHeader(tok)); rec.Code != http.StatusInternalServerError {
		t.Errorf("join = %d %s, want 500", rec.Code, body)
	}
}

func TestPreviewRevokedDenied(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	newInvite(t, app, list, "raw-token-revoked", inviteOpts{revoked: true})

	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"raw-token-revoked"}`, nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestPreviewExpiredDenied(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	newInvite(t, app, list, "raw-token-expired", inviteOpts{expired: true})

	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"raw-token-expired"}`, nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestPreviewRateLimited (§10): the preview route is rate-limited per IP.
// Uses a dedicated RemoteAddr (TEST-NET-3, 203.0.113.0/24) instead of
// httptest's default 192.0.2.1 so saturating this limiter cannot poison the
// shared RateInvitePreview bucket for any other test sharing that default IP.
func TestPreviewRateLimited(t *testing.T) {
	_, mux := setupInvitesApp(t)
	const ip = "203.0.113.9:1"

	previewReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/invites/preview", strings.NewReader(`{"token":"nope"}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	for i := range 30 {
		if rec := previewReq(); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d: rate-limited too early: %s", i+1, rec.Body.String())
		}
	}
	if rec := previewReq(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("31st preview attempt status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
}

// --- join ----------------------------------------------------------------

// TestJoinCreatesMembership: joining writes the joiner's membership and
// nothing else — there is no per-member name ([D-08]); the joiner sees the
// list under its one name, which the preview reports as it is NOW, not as it
// was when the link was minted.
func TestJoinCreatesMembership(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	renameList(t, app, list, "Familie")
	acct := newAccount(t, app, "joiner1")
	newInvite(t, app, list, "raw-token-join1", inviteOpts{})

	previewName := func() string {
		t.Helper()
		rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/preview", `{"token":"raw-token-join1"}`, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("preview status = %d, want 200: %s", rec.Code, rec.Body.String())
		}
		var resp struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal preview: %v", err)
		}
		return resp.Name
	}
	if got := previewName(); got != "Familie" {
		t.Errorf("preview name = %q, want %q", got, "Familie")
	}
	renameList(t, app, list, "Wocheneinkauf")
	if got := previewName(); got != "Wocheneinkauf" {
		t.Errorf("preview name after a rename = %q, want %q", got, "Wocheneinkauf")
	}

	tok, err := acct.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	// A stale client may still send display_name; the route ignores it.
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/join",
		`{"token":"raw-token-join1","display_name":"My Own Name"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	if n, _ := app.CountRecords("memberships", dbx.HashExp{"account": acct.Id, "list": list.Id}); n != 1 {
		t.Fatalf("joiner's memberships = %d, want 1", n)
	}
	after, err := app.FindRecordById("lists", list.Id)
	if err != nil {
		t.Fatalf("refetch list: %v", err)
	}
	if got := after.GetString("name"); got != "Wocheneinkauf" {
		t.Errorf("lists.name after join = %q, want %q (a join never renames)", got, "Wocheneinkauf")
	}
}

func TestJoinIsIdempotent(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	acct := newAccount(t, app, "joiner3")
	newInvite(t, app, list, "raw-token-join3", inviteOpts{})
	tok, err := acct.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	headers := testutil.AuthHeader(tok)

	first, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", `{"token":"raw-token-join3"}`, headers)
	if first.Code != http.StatusOK {
		t.Fatalf("first join status = %d, want 200: %s", first.Code, first.Body.String())
	}
	second, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", `{"token":"raw-token-join3"}`, headers)
	if second.Code != http.StatusOK {
		t.Fatalf("second join status = %d, want 200: %s", second.Code, second.Body.String())
	}

	n, err := app.CountRecords("memberships", dbx.HashExp{"account": acct.Id, "list": list.Id})
	if err != nil {
		t.Fatalf("count memberships: %v", err)
	}
	if n != 1 {
		t.Errorf("membership rows after two joins = %d, want 1", n)
	}
}

func TestJoinUnauthenticatedDenied(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	newInvite(t, app, list, "raw-token-noauth", inviteOpts{})

	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", `{"token":"raw-token-noauth"}`, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

func TestJoinRevokedOrExpiredDenied(t *testing.T) {
	app, mux := setupInvitesApp(t)

	cases := []struct {
		name   string
		opts   inviteOpts
		rawTok string
		handle string
	}{
		{"revoked", inviteOpts{revoked: true}, "raw-token-join-revoked", "joiner-rev"},
		{"expired", inviteOpts{expired: true}, "raw-token-join-expired", "joiner-exp"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			list := newList(t, app)
			acct := newAccount(t, app, tc.handle)
			newInvite(t, app, list, tc.rawTok, tc.opts)

			body := fmt.Sprintf(`{"token":%q}`, tc.rawTok)
			tok, err := acct.NewAuthToken()
			if err != nil {
				t.Fatalf("NewAuthToken: %v", err)
			}
			rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", body, testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
			}
			n, err := app.CountRecords("memberships", dbx.HashExp{"account": acct.Id, "list": list.Id})
			if err != nil {
				t.Fatalf("count memberships: %v", err)
			}
			if n != 0 {
				t.Errorf("membership rows created despite invalid invite = %d, want 0", n)
			}
		})
	}
}

// TestJoinRateLimited (§10): the join route is rate-limited per IP,
// independently of preview. Uses a dedicated RemoteAddr distinct from the
// preview test's to avoid cross-test bucket poisoning.
func TestJoinRateLimited(t *testing.T) {
	app, mux := setupInvitesApp(t)
	acct := newAccount(t, app, "rl-joiner")
	tok, err := acct.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	headers := testutil.AuthHeader(tok)
	const ip = "203.0.113.10:1"

	joinReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/invites/join", strings.NewReader(`{"token":"nope"}`))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	for i := range 30 {
		if rec := joinReq(); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d: rate-limited too early: %s", i+1, rec.Body.String())
		}
	}
	if rec := joinReq(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("31st join attempt status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
}

// A double-tapped join is idempotent too: two concurrent joins of one account
// both succeed with the same membership, and exactly one row exists.
func TestJoinIsIdempotentUnderConcurrency(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	newInvite(t, app, list, "raw-token-race", inviteOpts{})

	for round := range 10 {
		acct := newAccount(t, app, fmt.Sprintf("racer%d", round))
		tok, err := acct.NewAuthToken()
		if err != nil {
			t.Fatalf("NewAuthToken: %v", err)
		}
		start := make(chan struct{})
		codes := make(chan int, 2)
		for range 2 {
			go func() {
				req := httptest.NewRequest(http.MethodPost, "/api/invites/join", strings.NewReader(`{"token":"raw-token-race"}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", tok)
				req.RemoteAddr = fmt.Sprintf("203.0.113.%d:1", 20+round)
				rec := httptest.NewRecorder()
				<-start
				mux.ServeHTTP(rec, req)
				codes <- rec.Code
			}()
		}
		close(start)
		for range 2 {
			if code := <-codes; code != http.StatusOK {
				t.Fatalf("round %d: a concurrent join answered %d, want 200", round, code)
			}
		}
		n, err := app.CountRecords("memberships", dbx.HashExp{"account": acct.Id, "list": list.Id})
		if err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("round %d: membership rows = %d, want 1", round, n)
		}
	}
}

// A join for a list that no longer exists is refused like a dead invite, and
// stores no membership for it.
func TestJoinOfDeletedListDenied(t *testing.T) {
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	acct := newAccount(t, app, "late-joiner")
	newInvite(t, app, list, "raw-token-late", inviteOpts{})
	if _, err := app.DB().NewQuery("DELETE FROM lists WHERE id = {:id}").
		Bind(dbx.Params{"id": list.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	tok, err := acct.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", `{"token":"raw-token-late"}`, testutil.AuthHeader(tok))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("join of a deleted list: status %d, want 400: %s", rec.Code, body)
	}
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"list": list.Id}); n != 0 {
		t.Errorf("memberships on the deleted list = %d, want 0", n)
	}
}
