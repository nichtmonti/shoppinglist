package sectest

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"

	"shoppinglist/internal/invites"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/lists"
	"shoppinglist/internal/security"
	"shoppinglist/internal/sync"
	"shoppinglist/internal/testutil"
)

// setupRoutes is setup() plus the custom list/invite routes, which the invite
// flow needs end to end (setup() mounts only PocketBase's own record API).
func setupRoutes(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	app := testutil.NewApp(t)
	lists.Register(app)
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	g := security.AppRoutes(r)
	lists.RegisterRoutes(g, listcap.Default())
	invites.RegisterRoutes(g)
	sync.RegisterRoutes(g, listcap.Default())
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return app, mux
}

// mintToken drives POST /api/lists/{id}/invite and returns the raw token.
func mintToken(t *testing.T, mux http.Handler, listID, tok string) string {
	t.Helper()
	code, body := do(mux, http.MethodPost, "/api/lists/"+listID+"/invite", "", tok)
	if code != 200 {
		t.Fatalf("mint invite: %d %s", code, body)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode mint response: %v (%s)", err, body)
	}
	if out.Token == "" {
		t.Fatalf("mint returned no token: %s", body)
	}
	return out.Token
}

// TestRemovedMemberCannotRejoinViaPlantedInvite is the [D-31] regression.
//
// The attack: were invites client-created, Mallory would choose both the token
// (no entropy guarantee) and `created_by`. Were §7.3's cascade to revoke only
// a leaver's own invites (`WHERE list = ? AND created_by = ?`), an invite she
// attributed to another member would survive her departure, and she could
// rejoin from a brand-new account with a token she had picked and memorized.
// Removing her from the list would do nothing, because the rejoin is not as
// her.
//
// Two independent changes have to hold for this to stay dead, and the test
// exercises both: the client cannot write `created_by` (minting is a server
// route), and the cascade revokes the list's link on ANY departure rather than
// keying off authorship.
func TestRemovedMemberCannotRejoinViaPlantedInvite(t *testing.T) {
	app, mux := setupRoutes(t)

	victimID, victimTok := testutil.CreateAccount(t, app, "Victim")
	malloryID, malloryTok := testutil.CreateAccount(t, app, "Mallory")
	_, freshTok := testutil.CreateAccount(t, app, "Mallory-again")

	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, victimID, listID)

	// Mallory joins legitimately, via the victim's link.
	joinTok := mintToken(t, mux, listID, victimTok)
	body, _ := json.Marshal(map[string]string{"token": joinTok})
	if code, b := do(mux, http.MethodPost, "/api/invites/join", string(body), malloryTok); code != 200 {
		t.Fatalf("mallory join: %d %s", code, b)
	}

	// She plants a backdoor: mint a link, keep its token. She cannot influence
	// `created_by` any more — the route takes it from her own auth token — so
	// the row is attributable to her, but the point of the test is that it does
	// not matter either way.
	backdoor := mintToken(t, mux, listID, malloryTok)
	planted, err := app.FindFirstRecordByFilter("invites",
		"list = {:l} && revoked = false", dbx.Params{"l": listID})
	if err != nil {
		t.Fatalf("find planted invite: %v", err)
	}
	if planted.GetString("created_by") != malloryID {
		t.Errorf("planted invite attributed to %q, want Mallory (%q) — "+
			"created_by is client-controlled again",
			planted.GetString("created_by"), malloryID)
	}

	// She leaves (deletes her own membership row).
	mem, err := app.FindFirstRecordByFilter("memberships",
		"account = {:a} && list = {:l}", dbx.Params{"a": malloryID, "l": listID})
	if err != nil {
		t.Fatalf("find mallory membership: %v", err)
	}
	if code, b := do(mux, http.MethodDelete,
		"/api/collections/memberships/records/"+mem.Id, "", malloryTok); code != 204 {
		t.Fatalf("mallory leave: %d %s", code, b)
	}

	// The list's link must be dead — including the one she minted.
	live, err := app.FindRecordsByFilter("invites", "list = {:l} && revoked = false", "", 0, 0, dbx.Params{"l": listID})
	if err != nil {
		t.Fatalf("query live invites: %v", err)
	}
	if len(live) != 0 {
		t.Errorf("%d live invite(s) survived the leave", len(live))
	}

	// The actual exploit: rejoin from a FRESH account with the planted token.
	body, _ = json.Marshal(map[string]string{"token": backdoor})
	code, b := do(mux, http.MethodPost, "/api/invites/join", string(body), freshTok)
	if code == 200 {
		t.Fatalf("EXPLOITED: removed member rejoined list %s with a planted invite: %s", listID, b)
	}

	// And the victim is still alone on their list.
	if n, _ := app.CountRecords("memberships", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("memberships on the list = %d, want 1 (the victim only)", n)
	}
}

// TestMintRotatesTheSingleLink pins the [D-31] "one active link per list"
// invariant ([D-31]): a client-side revoke-then-create would leave the list
// linkless if the browser died mid-way, and two concurrent resets would
// produce two live links.
func TestMintRotatesTheSingleLink(t *testing.T) {
	app, mux := setupRoutes(t)

	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, acctID, listID)

	first := mintToken(t, mux, listID, tok)
	second := mintToken(t, mux, listID, tok)

	if first == second {
		t.Fatalf("rotation returned the same token twice")
	}

	live, err := app.FindRecordsByFilter("invites", "list = {:l} && revoked = false", "", 0, 0, dbx.Params{"l": listID})
	if err != nil {
		t.Fatalf("query live invites: %v", err)
	}
	if len(live) != 1 {
		t.Errorf("live invites after rotation = %d, want exactly 1", len(live))
	}
	// Both rows survive — revoked, not deleted (§13's sweep collects them).
	if n, _ := app.CountRecords("invites", dbx.HashExp{"list": listID}); n != 2 {
		t.Errorf("invites rows = %d, want 2 (one live, one revoked)", n)
	}

	// The superseded link no longer redeems.
	_, joinerTok := testutil.CreateAccount(t, app, "Bob")
	body, _ := json.Marshal(map[string]string{"token": first})
	if code, b := do(mux, http.MethodPost, "/api/invites/join", string(body), joinerTok); code == 200 {
		t.Errorf("EXPLOITED: the rotated-away token still joins: %s", b)
	}
}

// TestNonMemberCannotMintOrRevoke: both routes sit behind
// security.MemberRoutes, so a stranger gets the same 403 whether the
// list exists or not.
func TestNonMemberCannotMintOrRevoke(t *testing.T) {
	app, mux := setupRoutes(t)

	ownerID, _ := testutil.CreateAccount(t, app, "Owner")
	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, ownerID, listID)

	_, strangerTok := testutil.CreateAccount(t, app, "Stranger")

	for _, path := range []string{
		"/api/lists/" + listID + "/invite",
		"/api/lists/" + listID + "/invite/revoke",
	} {
		if code, b := do(mux, http.MethodPost, path, "{}", strangerTok); code != 403 {
			t.Errorf("non-member POST %s = %d, want 403: %s", path, code, b)
		}
	}

	if n, _ := app.CountRecords("invites", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("stranger minted %d invite(s)", n)
	}
}
