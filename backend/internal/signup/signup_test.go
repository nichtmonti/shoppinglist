package signup

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/settings"
	"shoppinglist/internal/testutil"
)

// liveInvite stores a list's invite the way the mint route does (only the
// token's sha256) and returns the raw token a link would carry.
func liveInvite(t *testing.T, app core.App, listID, creator, token string, expires time.Time) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(token))
	rec := core.NewRecord(col)
	rec.Set("list", listID)
	rec.Set("token_hash", hex.EncodeToString(sum[:]))
	rec.Set("created_by", creator)
	exp, _ := types.ParseDateTime(expires)
	rec.Set("expires_at", exp)
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// household is an instance with one account on one list, and that list's
// live invite link.
func household(t *testing.T) (app core.App, listID string, invite *core.Record, token string) {
	t.Helper()
	app = testutil.NewApp(t)
	owner, _ := testutil.CreateAccount(t, app, "Alice")
	listID = testutil.CreateListFor(t, app, owner, "Wocheneinkauf")
	token = "the-list-link-token"
	invite = liveInvite(t, app, listID, owner, token, time.Now().Add(24*time.Hour))
	return app, listID, invite, token
}

func refused(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, ErrRefused) {
		t.Errorf("%s: err = %v, want ErrRefused", what, err)
	}
}

func TestOpenNeedsNoLink(t *testing.T) {
	app := testutil.NewApp(t)
	g := NewGate(Open)
	ticket, err := g.Admit(app, Links{})
	if err != nil || ticket != (Ticket{}) {
		t.Fatalf("Admit = %+v, %v; want the zero ticket", ticket, err)
	}
	if listID, err := g.Redeem(app, ticket); err != nil || listID != "" {
		t.Errorf("Redeem = %q, %v; want no list", listID, err)
	}
}

func TestClosedRefusesEvenWithALink(t *testing.T) {
	app, _, _, token := household(t)
	g := NewGate(Closed)
	_, err := g.Admit(app, Links{Invite: token})
	refused(t, "Admit with a live invite", err)
	_, err = g.Redeem(app, Ticket{Invite: hashOf(token)})
	refused(t, "Redeem with a live invite", err)
}

// TestInviteJoinsTheLinksList: under invite, a list's live link admits a
// visitor, and finish learns the list the new account joins.
func TestInviteJoinsTheLinksList(t *testing.T) {
	app, listID, _, token := household(t)
	g := NewGate(Invite)
	ticket, err := g.Admit(app, Links{Invite: token})
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if ticket.Invite != hashOf(token) {
		t.Errorf("ticket carries %q, want the token's hash", ticket.Invite)
	}
	got, err := g.Redeem(app, ticket)
	if err != nil || got != listID {
		t.Errorf("Redeem = %q, %v; want %q", got, err, listID)
	}
}

func TestInviteRefusesWithoutAValidLink(t *testing.T) {
	app, _, invite, token := household(t)
	g := NewGate(Invite)
	for name, links := range map[string]Links{
		"no link":         {},
		"unknown token":   {Invite: "not-a-link"},
		"overlong":        {Invite: string(make([]byte, 200))},
		"setup, none out": {Setup: token},
	} {
		_, err := g.Admit(app, links)
		refused(t, name, err)
	}

	invite.Set("revoked", true)
	if err := app.SaveNoValidate(invite); err != nil {
		t.Fatal(err)
	}
	_, err := g.Admit(app, Links{Invite: token})
	refused(t, "revoked link", err)
}

func TestInviteRefusesAnExpiredLink(t *testing.T) {
	app := testutil.NewApp(t)
	owner, _ := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, owner, "Alt")
	liveInvite(t, app, listID, owner, "old", time.Now().Add(-time.Hour))
	_, err := NewGate(Invite).Admit(app, Links{Invite: "old"})
	refused(t, "expired link", err)
}

// TestRedeemChecksTheLinkAgain: a link revoked between begin and finish — a
// member pressed „Neuer Link“ mid-ceremony — no longer admits, and nor
// does a ticket begun while signup was open once a restart made it invite.
func TestRedeemChecksTheLinkAgain(t *testing.T) {
	app, _, invite, token := household(t)
	g := NewGate(Invite)
	ticket, err := g.Admit(app, Links{Invite: token})
	if err != nil {
		t.Fatal(err)
	}
	invite.Set("revoked", true)
	if err := app.SaveNoValidate(invite); err != nil {
		t.Fatal(err)
	}
	_, err = g.Redeem(app, ticket)
	refused(t, "link revoked mid-ceremony", err)

	_, err = g.Redeem(app, Ticket{})
	refused(t, "ticket from an open instance", err)
}

// TestSetupLinkAdmitsTheFirstAccountOnly: the setup link exists only on an
// invite-only instance with no account, admits while there is none, and
// stops the moment one exists — also if every account is deleted again.
func TestSetupLinkAdmitsTheFirstAccountOnly(t *testing.T) {
	app := testutil.NewApp(t)

	if _, ok, err := NewGate(Open).StartSetup(app); ok || err != nil {
		t.Errorf("open instance minted a setup link (ok=%v, err=%v)", ok, err)
	}
	if _, ok, err := NewGate(Closed).StartSetup(app); ok || err != nil {
		t.Errorf("closed instance minted a setup link (ok=%v, err=%v)", ok, err)
	}

	g := NewGate(Invite)
	token, ok, err := g.StartSetup(app)
	if err != nil || !ok || len(token) < 40 {
		t.Fatalf("StartSetup = %q, %v, %v; want a fresh token", token, ok, err)
	}
	_, err = g.Admit(app, Links{Setup: "a-guess"})
	refused(t, "wrong setup token", err)

	ticket, err := g.Admit(app, Links{Setup: token})
	if err != nil || ticket.Setup == "" {
		t.Fatalf("Admit with the setup token = %+v, %v", ticket, err)
	}
	if listID, err := g.Redeem(app, ticket); err != nil || listID != "" {
		t.Fatalf("Redeem = %q, %v; want no list and no error", listID, err)
	}

	// A second visitor who began with the same link before the first one
	// finished: the account now exists, so the link no longer admits.
	accountID, _ := testutil.CreateAccount(t, app, "First")
	_, err = g.Redeem(app, ticket)
	refused(t, "setup link once an account exists", err)
	g.Redeemed(ticket)

	// Retired for good: deleting the account does not bring it back.
	acct, err := app.FindRecordById("accounts", accountID)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Delete(acct); err != nil {
		t.Fatal(err)
	}
	_, err = g.Admit(app, Links{Setup: token})
	refused(t, "setup link after it was redeemed", err)
}

func TestNoSetupLinkOnceAnAccountExists(t *testing.T) {
	app := testutil.NewApp(t)
	testutil.CreateAccount(t, app, "Alice")
	if _, ok, err := NewGate(Invite).StartSetup(app); ok || err != nil {
		t.Errorf("StartSetup with an account: ok=%v, err=%v; want no link", ok, err)
	}
}

// ModeFromEnv reads the mode as the start does, for the tests that set it.
func ModeFromEnv() (Mode, error) {
	s, err := settings.ReadServe()
	if err != nil {
		return "", err
	}
	return ParseMode(s.Signup)
}

func TestModeFromEnv(t *testing.T) {
	for value, want := range map[string]Mode{"": Open, "open": Open, "closed": Closed, " INVITE ": Invite} {
		t.Setenv(Env, value)
		if got, err := ModeFromEnv(); err != nil || got != want {
			t.Errorf("%s=%q: %q, %v; want %q", Env, value, got, err, want)
		}
	}
	for _, value := range []string{"invites", "true", "on"} {
		t.Setenv(Env, value)
		if _, err := ModeFromEnv(); err == nil {
			t.Errorf("%s=%q accepted", Env, value)
		}
	}
}

func hashOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
