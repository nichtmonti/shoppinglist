package invites

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// mkMember creates an account + its membership on list, returning the bearer.
func mkMember(t *testing.T, app core.App, list *core.Record, nick string) string {
	t.Helper()
	acctID, tok := testutil.CreateAccount(t, app, nick)
	col, err := app.FindCollectionByNameOrId("memberships")
	if err != nil {
		t.Fatalf("find memberships collection: %v", err)
	}
	m := core.NewRecord(col)
	m.Set("account", acctID)
	m.Set("list", list.Id)
	if err := app.SaveNoValidate(m); err != nil {
		t.Fatalf("save membership: %v", err)
	}
	return tok
}

// mint drives POST /api/lists/{id}/invite and returns the decoded response.
func mint(t *testing.T, mux http.Handler, listID, tok, body string) (int, mintResponse) {
	t.Helper()
	rec, raw := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+listID+"/invite", body, testutil.AuthHeader(tok))
	var out mintResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal([]byte(raw), &out); err != nil {
			t.Fatalf("decode mint response: %v (%s)", err, raw)
		}
	}
	return rec.Code, out
}

func setupManage(t *testing.T) (*pocketbase.PocketBase, http.Handler, *core.Record, string) {
	t.Helper()
	app, mux := setupInvitesApp(t)
	list := newList(t, app)
	tok := mkMember(t, app, list, "Alice")
	return app, mux, list, tok
}

// TestMintReturnsUsableToken: the raw token comes back exactly once and
// redeems through the ordinary join route.
func TestMintReturnsUsableToken(t *testing.T) {
	app, mux, list, tok := setupManage(t)

	code, out := mint(t, mux, list.Id, tok, "")
	if code != http.StatusOK {
		t.Fatalf("mint status = %d", code)
	}
	if out.Token == "" {
		t.Fatal("mint returned no token")
	}

	// 32 bytes of entropy, base64url — server-minted, not a client promise ([D-31]).
	raw, err := base64.RawURLEncoding.DecodeString(out.Token)
	if err != nil {
		t.Errorf("token is not base64url: %v", err)
	}
	if len(raw) != randid.TokenBytes {
		t.Errorf("token decodes to %d bytes, want %d", len(raw), randid.TokenBytes)
	}

	// Looked up by its hash; the token itself is kept for the other members'
	// share sheets while the link is live ([D-294]).
	stored, err := app.FindRecordById("invites", out.ID)
	if err != nil {
		t.Fatalf("find minted invite: %v", err)
	}
	if stored.GetString("token_hash") != randid.HashToken(out.Token) {
		t.Error("stored token_hash does not match the issued token")
	}
	if stored.GetString("token") != out.Token {
		t.Error("the live link's token is not kept for the other members")
	}

	// And it redeems.
	joiner := testutil.CreateAccount
	_, joinerTok := joiner(t, app, "Bob")
	body, _ := json.Marshal(map[string]string{"token": out.Token})
	rec, raw2 := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", string(body), testutil.AuthHeader(joinerTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("join with minted token = %d: %s", rec.Code, raw2)
	}
}

// TestMintStampsServerOwnedFields: `created_by` comes from the caller's token
// and `expires_at` from the server clock — neither is reachable from the body
// ([D-31]). Before this, both were client-supplied.
func TestMintStampsServerOwnedFields(t *testing.T) {
	app, mux, list, tok := setupManage(t)

	victimID, _ := testutil.CreateAccount(t, app, "Victim")

	before := types.NowDateTime()
	code, out := mint(t, mux, list.Id, tok,
		`{"created_by":"`+victimID+`","expires_at":"2099-01-01 10:00:00.000Z","revoked":true,"token_hash":"deadbeef"}`)
	if code != http.StatusOK {
		t.Fatalf("mint status = %d", code)
	}

	rec, err := app.FindRecordById("invites", out.ID)
	if err != nil {
		t.Fatalf("find invite: %v", err)
	}
	if got := rec.GetString("created_by"); got == victimID {
		t.Error("created_by was taken from the request body — the [D-31] hole is back")
	}
	if rec.GetBool("revoked") {
		t.Error("revoked was taken from the request body")
	}
	if rec.GetString("token_hash") != randid.HashToken(out.Token) {
		t.Error("token_hash was taken from the request body")
	}

	exp := rec.GetDateTime("expires_at").Time()
	want := before.Time().Add(inviteLifetime)
	if exp.Before(want.Add(-time.Minute)) || exp.After(want.Add(time.Minute)) {
		t.Errorf("expires_at = %v, want ~%v (server-set, %v)", exp, want, inviteLifetime)
	}
}

// TestMintRotatesInOneTransaction: the previous link is revoked and the new one
// created together, leaving exactly one live row ([D-31]).
func TestMintRotatesInOneTransaction(t *testing.T) {
	app, mux, list, tok := setupManage(t)

	_, first := mint(t, mux, list.Id, tok, `{}`)
	_, second := mint(t, mux, list.Id, tok, `{}`)

	if first.Token == second.Token {
		t.Fatal("rotation reissued the same token")
	}
	live, err := app.FindRecordsByFilter("invites", "list = {:l} && revoked = false", "", 0, 0, dbx.Params{"l": list.Id})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(live) != 1 {
		t.Errorf("live invites = %d, want 1", len(live))
	}
	if n, _ := app.CountRecords("invites", dbx.HashExp{"list": list.Id}); n != 2 {
		t.Errorf("total invites = %d, want 2 (revoked rows are kept for audit)", n)
	}
}

// TestMintRevokesExpiredPredecessor: an expired-but-unrevoked row still holds
// the partial unique index's slot, so minting has to clear it too.
func TestMintRevokesExpiredPredecessor(t *testing.T) {
	app, mux, list, tok := setupManage(t)

	newInvite(t, app, list, "stale-token", inviteOpts{expired: true})

	code, out := mint(t, mux, list.Id, tok, `{}`)
	if code != http.StatusOK {
		t.Fatalf("mint over an expired invite = %d", code)
	}
	if out.Token == "" {
		t.Fatal("no token issued")
	}
	live, _ := app.FindRecordsByFilter("invites", "list = {:l} && revoked = false", "", 0, 0, dbx.Params{"l": list.Id})
	if len(live) != 1 {
		t.Errorf("live invites = %d, want 1", len(live))
	}
}

// TestRevokeRouteRetiresTheLink: revoke kills the link without evicting anyone,
// and is idempotent.
func TestRevokeRouteRetiresTheLink(t *testing.T) {
	app, mux, list, tok := setupManage(t)

	_, out := mint(t, mux, list.Id, tok, `{}`)

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+list.Id+"/invite/revoke", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke = %d: %s", rec.Code, body)
	}

	// The token no longer redeems.
	_, joinerTok := testutil.CreateAccount(t, app, "Bob")
	jb, _ := json.Marshal(map[string]string{"token": out.Token})
	if r, b := testutil.DoReq(mux, http.MethodPost, "/api/invites/join", string(jb), testutil.AuthHeader(joinerTok)); r.Code == http.StatusOK {
		t.Errorf("revoked token still joins: %s", b)
	}

	// A dead link is no one's to share: its token is gone ([D-294]).
	if stored, err := app.FindRecordById("invites", out.ID); err != nil || stored.GetString("token") != "" {
		t.Errorf("revoked invite still holds its token (err %v)", err)
	}

	// The member who was already on the list stays.
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"list": list.Id}); n != 1 {
		t.Errorf("memberships = %d, want 1 (revoke must not evict)", n)
	}

	// Idempotent.
	if r, b := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+list.Id+"/invite/revoke", "", testutil.AuthHeader(tok)); r.Code != http.StatusOK {
		t.Errorf("second revoke = %d, want 200: %s", r.Code, b)
	}
}

// TestMintRequiresAuth: unauthenticated callers are refused before any row is
// written (security.MemberRoutes, like every other list-scoped route).
func TestMintRequiresAuth(t *testing.T) {
	app, mux, list, _ := setupManage(t)

	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+list.Id+"/invite", `{}`, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated mint = %d, want 401", rec.Code)
	}
	if n, _ := app.CountRecords("invites", dbx.HashExp{"list": list.Id}); n != 0 {
		t.Errorf("unauthenticated mint wrote %d invite(s)", n)
	}
}

// TestMintAfterLeaving (§7.3): the caller leaves the list on another device
// between the gate and the transaction; the mint refuses and leaves no invite.
func TestMintAfterLeaving(t *testing.T) {
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		security.MemberRoutes(r).POST("/api/lists/{listId}/invite", mintInvite).BindFunc(testutil.LeaveAfterGate)
	})
	list := newList(t, app)
	tok := mkMember(t, app, list, "Alice")

	if code, _ := mint(t, mux, list.Id, tok, `{}`); code != http.StatusForbidden {
		t.Errorf("mint after leaving = %d, want 403", code)
	}
	if n, err := app.CountRecords("invites", dbx.HashExp{"list": list.Id}); err != nil || n != 0 {
		t.Errorf("mint after leaving wrote %d invite(s) (err %v)", n, err)
	}
}

// TestRevokeRateLimit: revoke had no §10 budget while its twin, mint, did —
// an asymmetry with no reason behind it. Revoke is idempotent (a list with no
// live link answers 200 with revoked: 0), so the budget is the only thing
// bounding how often it can be called.
func TestRevokeRateLimit(t *testing.T) {
	_, mux, list, tok := setupManage(t)

	const quota = 30
	call := func() int {
		rec, _ := testutil.DoReq(mux, http.MethodPost,
			"/api/lists/"+list.Id+"/invite/revoke", "", testutil.AuthHeader(tok))
		return rec.Code
	}
	for i := range quota {
		if code := call(); code == http.StatusTooManyRequests {
			t.Fatalf("revoke %d of %d: rate-limited too early", i+1, quota)
		}
	}
	if code := call(); code != http.StatusTooManyRequests {
		t.Errorf("revoke %d status = %d, want 429", quota+1, code)
	}
}

// TestMembersReadTheLiveLink: any member reads the live link's token through
// the collection's own rules, and someone not on the list does not ([D-294]).
func TestMembersReadTheLiveLink(t *testing.T) {
	app, mux, list, aliceTok := setupManage(t)
	bobTok := mkMember(t, app, list, "Bob")
	_, strangerTok := testutil.CreateAccount(t, app, "Eve")

	_, out := mint(t, mux, list.Id, aliceTok, "")

	read := func(tok string) string {
		rec, body := testutil.DoReq(mux, http.MethodGet, "/api/collections/invites/records/"+out.ID, "", testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			return ""
		}
		var row struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal([]byte(body), &row)
		return row.Token
	}
	if got := read(bobTok); got != out.Token {
		t.Errorf("another member reads token %q, want the live link's", got)
	}
	if got := read(strangerTok); got != "" {
		t.Errorf("a non-member read the token %q", got)
	}
}
