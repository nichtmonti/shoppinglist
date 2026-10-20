package account

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"shoppinglist/internal/testutil"
)

// Coverage for the §5.6 "log out everywhere" rotation route. The feature's
// whole claim is "previously issued tokens stop working" — TestRotateTokenKey-
// InvalidatesExistingToken proves it against the pinned PocketBase.

// TestRotateTokenKeyInvalidatesExistingToken: mint a token, rotate with it,
// then reuse the SAME token on an ordinary authenticated endpoint and assert
// it is now rejected. If PB's token verification were not keyed on tokenKey,
// this route would be theatre.
func TestRotateTokenKeyInvalidatesExistingToken(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Alice", "")

	// Sanity: the token works before rotation (own-row read via the default REST API).
	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/collections/accounts/records/"+acct.Id, "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("pre-rotation read status = %d, want 200: %s", rec.Code, body)
	}

	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/account/rotate-token-key", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, want 200: %s", rec.Code, body)
	}

	rec, body = testutil.DoReq(mux, http.MethodGet, "/api/collections/accounts/records/"+acct.Id, "", testutil.AuthHeader(tok))
	if rec.Code == http.StatusOK {
		t.Fatalf("THE OLD TOKEN STILL WORKS after rotation — §5.6 revocation is a no-op: %s", body)
	}
}

// TestRotateTokenKeyChangesStoredKey: the stored tokenKey actually differs
// afterwards (the mechanism, independent of the token layer above).
func TestRotateTokenKeyChangesStoredKey(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Alice", "")

	before, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	oldKey := before.GetString("tokenKey")
	if oldKey == "" {
		t.Fatal("precondition: account has no tokenKey")
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/rotate-token-key", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, want 200: %s", rec.Code, body)
	}

	after, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if got := after.GetString("tokenKey"); got == oldKey {
		t.Error("tokenKey unchanged after rotation")
	} else if got == "" {
		t.Error("tokenKey blanked rather than regenerated")
	}
}

// TestRotateTokenKeyUnauthenticated: no token → 401, nothing rotated.
func TestRotateTokenKeyUnauthenticated(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, _ := createAccount(t, app, "Alice", "")
	before, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/rotate-token-key", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated rotate status = %d, want 401: %s", rec.Code, body)
	}

	after, err := app.FindRecordById("accounts", acct.Id)
	if err != nil {
		t.Fatalf("find account: %v", err)
	}
	if after.GetString("tokenKey") != before.GetString("tokenKey") {
		t.Error("tokenKey rotated by an unauthenticated request")
	}
}

// TestRotateTokenKeyIsPerAccount: rotation is scoped to the caller — a second
// account's key and token must be untouched. "Log out everywhere" means every
// one of YOUR devices, not everyone's.
func TestRotateTokenKeyIsPerAccount(t *testing.T) {
	app, mux := setupDeleteApp(t)
	_, tokA := createAccount(t, app, "Alice", "")
	acctB, tokB := createAccount(t, app, "Bob", "")

	beforeB, err := app.FindRecordById("accounts", acctB.Id)
	if err != nil {
		t.Fatalf("find B: %v", err)
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/rotate-token-key", "", testutil.AuthHeader(tokA))
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, want 200: %s", rec.Code, body)
	}

	afterB, err := app.FindRecordById("accounts", acctB.Id)
	if err != nil {
		t.Fatalf("find B: %v", err)
	}
	if afterB.GetString("tokenKey") != beforeB.GetString("tokenKey") {
		t.Error("B's tokenKey rotated by A's request")
	}
	rec, body = testutil.DoReq(mux, http.MethodGet, "/api/collections/accounts/records/"+acctB.Id, "", testutil.AuthHeader(tokB))
	if rec.Code != http.StatusOK {
		t.Errorf("B's token stopped working after A rotated: status = %d: %s", rec.Code, body)
	}
}

// TestRotateTokenKeyCutsAnOpenRealtimeStream: "log out everywhere" must also
// stop a realtime stream opened with an old token, or a stolen token keeps
// receiving the list's changes until the stream drops (§5.6). PocketBase
// unsets a client's auth when its record's tokenKey changes; this pins that
// the rotation reaches it, and an items event, which needs a member, then no
// longer arrives.
func TestRotateTokenKeyCutsAnOpenRealtimeStream(t *testing.T) {
	app, mux := setupDeleteApp(t)
	acct, tok := createAccount(t, app, "Alice", "")
	listID := testutil.CreateListFor(t, app, acct.Id, "Groceries")
	item := testutil.CreateItem(t, app, listID, "Milk")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/realtime", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { res.Body.Close() })
	events := make(chan string, 16) // "<event name> <data>"
	go func() {
		defer close(events)
		scan := bufio.NewScanner(res.Body)
		name := ""
		for scan.Scan() {
			line := scan.Text()
			if v, ok := strings.CutPrefix(line, "event:"); ok {
				name = v
			} else if v, ok := strings.CutPrefix(line, "data:"); ok {
				events <- name + " " + v
			}
		}
	}()
	next := func(wait time.Duration) (string, bool) {
		select {
		case ev, ok := <-events:
			return ev, ok
		case <-time.After(wait):
			return "", false
		}
	}
	connect, ok := next(5 * time.Second)
	if !ok || !strings.HasPrefix(connect, "PB_CONNECT ") {
		t.Fatalf("first event = %q, want PB_CONNECT", connect)
	}
	var hello struct {
		ClientID string `json:"clientId"`
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(connect, "PB_CONNECT ")), &hello); err != nil {
		t.Fatal(err)
	}
	// Over the server too: PocketBase ties the subscription to the stream's IP.
	sub, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/realtime",
		strings.NewReader(`{"clientId":"`+hello.ClientID+`","subscriptions":["items"]}`))
	sub.Header.Set("Content-Type", "application/json")
	sub.Header.Set("Authorization", "Bearer "+tok)
	subRes, err := http.DefaultClient.Do(sub)
	if err != nil {
		t.Fatal(err)
	}
	subRes.Body.Close()
	if subRes.StatusCode != http.StatusNoContent {
		t.Fatalf("subscribe = %d", subRes.StatusCode)
	}
	rename := func(name string) {
		t.Helper()
		item.Set("name", name)
		if err := app.Save(item); err != nil {
			t.Fatal(err)
		}
	}

	// The control: the stream carries the list's changes before the rotation.
	rename("Oat milk")
	if ev, ok := next(5 * time.Second); !ok || !strings.HasPrefix(ev, "items ") {
		t.Fatalf("event before the rotation = %q, want an items event", ev)
	}

	if rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/rotate-token-key", "", testutil.AuthHeader(tok)); rec.Code != http.StatusOK {
		t.Fatalf("rotate = %d: %s", rec.Code, body)
	}
	rename("Soy milk")
	if ev, ok := next(2 * time.Second); ok {
		t.Errorf("after the rotation the old token's stream still got %q", ev)
	}
}
