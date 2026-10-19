package webauthn

import (
	"errors"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

// TestCreateSessionEnforcesOneToOneSemantics (§5.5): re-begin with the same
// browser_id supersedes any prior ceremony — exactly one session
// exists for that browser_id and the latest wins.
func TestCreateSessionEnforcesOneToOneSemantics(t *testing.T) {
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	app := testutil.NewApp(t)

	// Create first session for browser_id "bid-X"
	first := &webauthn.SessionData{
		Challenge: "first",
	}
	createSession(app, "bid-X", "registration", first, nil, "", "")

	// Count records after first create
	count := sessionCount(app, "bid-X")
	if count != 1 {
		t.Errorf("webauthn_sessions for bid-X after first create = %d, want 1", count)
	}

	// Load the first session to verify it exists
	sess1, err := peekSession(app, "bid-X", "registration")
	if err != nil {
		t.Fatalf("load first session: %v", err)
	}
	if sess1.Session.Challenge != "first" {
		t.Errorf("first session challenge = %q, want 'first'", sess1.Session.Challenge)
	}

	// Create second session for SAME browser_id "bid-X" — this should delete the first
	second := &webauthn.SessionData{
		Challenge: "second",
	}
	createSession(app, "bid-X", "registration", second, nil, "", "")

	// Count records after second create — STILL exactly ONE
	count = sessionCount(app, "bid-X")
	if count != 1 {
		t.Errorf("webauthn_sessions for bid-X after second create = %d, want 1", count)
	}

	// Load the session — it should be the SECOND one (latest wins)
	sess2, err := peekSession(app, "bid-X", "registration")
	if err != nil {
		t.Fatalf("load session after re-begin: %v", err)
	}
	if sess2.Session.Challenge != "second" {
		t.Errorf("session challenge after re-begin = %q, want 'second'", sess2.Session.Challenge)
	}
}

// TestCreateSessionDoesNotClobberOtherType: a background conditional-mediation
// login/begin ([D-69]) racing a foreground registration/begin on the SAME
// browser_id must not delete each other's session — the two ceremonies are
// causally unrelated and can legitimately overlap on one browser.
func TestCreateSessionDoesNotClobberOtherType(t *testing.T) {
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	app := testutil.NewApp(t)

	reg := &webauthn.SessionData{Challenge: "reg"}
	createSession(app, "bid-X", "registration", reg, nil, "", "")

	login := &webauthn.SessionData{Challenge: "login"}
	createSession(app, "bid-X", "login", login, nil, "", "")

	count := sessionCount(app, "bid-X")
	if count != 2 {
		t.Errorf("webauthn_sessions for bid-X after both begins = %d, want 2 (one per type)", count)
	}

	regSess, err := peekSession(app, "bid-X", "registration")
	if err != nil {
		t.Fatalf("registration session was clobbered by the login begin: %v", err)
	}
	if regSess.Session.Challenge != "reg" {
		t.Errorf("registration session challenge = %q, want 'reg'", regSess.Session.Challenge)
	}

	loginSess, err := peekSession(app, "bid-X", "login")
	if err != nil {
		t.Fatalf("load login session: %v", err)
	}
	if loginSess.Session.Challenge != "login" {
		t.Errorf("login session challenge = %q, want 'login'", loginSess.Session.Challenge)
	}
}

// A ceremony session is single-use under concurrency too: of several finishes
// racing for one session, exactly one gets it.
func TestConsumeSessionIsSingleUseUnderConcurrency(t *testing.T) {
	app := testutil.NewApp(t)
	for round := range 20 {
		createSession(app, "bid-race", sessionTypeLogin, &webauthn.SessionData{Challenge: "c"}, nil, "", "")
		const racers = 4
		start := make(chan struct{})
		got := make(chan bool, racers)
		for range racers {
			go func() {
				<-start
				e := &core.RequestEvent{}
				e.App = app
				s, err := consumeSession(e, "bid-race", sessionTypeLogin, "")
				got <- err == nil && s != nil
			}()
		}
		close(start)
		wins := 0
		for range racers {
			if <-got {
				wins++
			}
		}
		if wins != 1 {
			t.Fatalf("round %d: %d finishes consumed the one session, want 1", round, wins)
		}
	}
}

// peekSession reads the (browser_id, type) session without consuming it.
func peekSession(app core.App, browserID, typ string) (*storedSession, error) {
	c := ceremoniesOf(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	got, ok := c.byKey[ceremonyKey{browserID, typ}]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return &got.session, nil
}

// sessionCount is the number of open sessions for browserID, or of all of
// them when browserID is "".
func sessionCount(app core.App, browserID string) int {
	c := ceremoniesOf(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for k := range c.byKey {
		if browserID == "" || k.browserID == browserID {
			n++
		}
	}
	return n
}

// expireSession moves browserID's sessions past their TTL.
func expireSession(t *testing.T, app core.App, browserID string) {
	t.Helper()
	c := ceremoniesOf(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	found := false
	for k, v := range c.byKey {
		if k.browserID == browserID {
			v.expires = time.Now().Add(-time.Second)
			c.byKey[k] = v
			found = true
		}
	}
	if !found {
		t.Fatalf("no session for %s", browserID)
	}
}

// A finish signed in as another account neither gets the session nor burns
// it for its owner.
func TestTakeSessionIsBoundToItsAccount(t *testing.T) {
	app := testutil.NewApp(t)
	createSession(app, "bid-acct", sessionTypeRegister, &webauthn.SessionData{Challenge: "c"}, nil, "acct-1", "")
	if _, err := takeSession(app, "bid-acct", sessionTypeRegister, "acct-2"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("take as another account: err = %v, want ErrSessionNotFound", err)
	}
	if _, err := takeSession(app, "bid-acct", sessionTypeRegister, "acct-1"); err != nil {
		t.Fatalf("take as the owner after a stranger's attempt: %v", err)
	}
}

// Opening a session drops the expired ones, so abandoned ceremonies do not
// pile up in memory.
func TestCreateSessionDropsExpiredSessions(t *testing.T) {
	app := testutil.NewApp(t)
	createSession(app, "bid-old", sessionTypeLogin, &webauthn.SessionData{Challenge: "old"}, nil, "", "")
	createSession(app, "bid-live", sessionTypeLogin, &webauthn.SessionData{Challenge: "live"}, nil, "", "")
	expireSession(t, app, "bid-old")

	createSession(app, "bid-new", sessionTypeLogin, &webauthn.SessionData{Challenge: "new"}, nil, "", "")
	if n := sessionCount(app, "bid-old"); n != 0 {
		t.Errorf("expired sessions after a begin = %d, want 0", n)
	}
	if n := sessionCount(app, ""); n != 2 {
		t.Errorf("open sessions = %d, want 2 (the live one and the new one)", n)
	}
}
