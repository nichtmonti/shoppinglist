// Package signup decides who may create a new passkey account
// (SHOPPINGLIST_SIGNUP, [D-61], [D-241]): anyone (open), no one (closed), or a
// visitor with a link (invite): a list's invite link (§7.1), or, while the
// instance has no account, the setup link the boot logs.
//
// It governs NEW anonymous passkey accounts only; sign-in, adding a passkey
// and a first OIDC sign-in never pass through it.
package signup

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/core"
	pbsecurity "github.com/pocketbase/pocketbase/tools/security"

	"shoppinglist/internal/envflag"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/randid"
)

// Mode is SHOPPINGLIST_SIGNUP's value.
type Mode string

const (
	Open   Mode = "open"
	Closed Mode = "closed"
	Invite Mode = "invite"
)

// Env is the variable the mode is read from.
const Env = "SHOPPINGLIST_SIGNUP"

// ModeFromEnv parses SHOPPINGLIST_SIGNUP. Unset means open. An unrecognised
// value is an error, not a fallback: a typo of `closed` must not boot wide
// open.
func ModeFromEnv() (Mode, error) {
	switch v := strings.ToLower(envflag.Get(Env)); v {
	case "":
		return Open, nil
	case string(Open), string(Closed), string(Invite):
		return Mode(v), nil
	default:
		return "", fmt.Errorf("%s (%q) must be %q, %q or %q", Env, v, Open, Closed, Invite)
	}
}

// ErrRefused is the one refusal for every way a new account is turned away,
// so the answer does not tell an unknown link from a revoked one (§7.6).
var ErrRefused = errors.New("registration is closed on this instance")

// Links is the raw tokens a visitor presents at register/begin.
type Links struct {
	Invite string
	Setup  string
}

// Ticket is which link let a new-account ceremony in, carried from begin to
// finish as a hash: the raw token is never stored ([D-31]). The zero Ticket
// is a signup that needed no link.
type Ticket struct {
	Invite string `json:"invite,omitempty"` // invites.token_hash
	Setup  string `json:"setup,omitempty"`  // sha256 of the setup token
}

// Gate is the instance's signup policy, plus the setup link while one is out.
// The setup token lives in memory only, so a restart retires it.
type Gate struct {
	Mode Mode

	mu        sync.Mutex
	setupHash string // hex sha256 of the setup token; "" while none is out
}

// NewGate returns the gate for mode, with no setup link out.
func NewGate(mode Mode) *Gate {
	return &Gate{Mode: mode}
}

// AnyoneMaySignUp reports whether a visitor needs no link.
func (g *Gate) AnyoneMaySignUp() bool { return g.Mode == Open }

// LinksAdmit reports whether a link can let a visitor in: true for open
// (which needs none) and invite, false for closed.
func (g *Gate) LinksAdmit() bool { return g.Mode != Closed }

// StartSetup mints the setup link's token when the mode is invite and the
// instance has no account yet; ok is false otherwise. It replaces any token
// minted before.
func (g *Gate) StartSetup(app core.App) (token string, ok bool, err error) {
	if g.Mode != Invite {
		return "", false, nil
	}
	n, err := app.CountRecords("accounts")
	if err != nil || n > 0 {
		return "", false, err
	}
	token = randid.Token()
	g.mu.Lock()
	g.setupHash = pbsecurity.SHA256(token)
	g.mu.Unlock()
	return token, true, nil
}

// Admit decides register/begin for a visitor who is not signed in: the
// ticket for finish, or ErrRefused.
func (g *Gate) Admit(app core.App, links Links) (Ticket, error) {
	switch g.Mode {
	case Open:
		return Ticket{}, nil
	case Invite:
		if h, ok := randid.LookupHash(links.Setup); ok {
			ok, err := g.setupValid(app, h)
			if err != nil || ok {
				return Ticket{Setup: h}, err
			}
		}
		if h, ok := randid.LookupHash(links.Invite); ok {
			_, live, err := invites.LiveListByHash(app, h)
			if err != nil || live {
				return Ticket{Invite: h}, err
			}
		}
	}
	return Ticket{}, ErrRefused
}

// Redeem decides register/finish inside the transaction that saves the
// account, re-checking the ticket against the state now (the link may be
// revoked, expired or used, the mode changed by a restart). It returns the
// list the account joins ("" for none), so a list's link cannot be used as a
// bare signup key: its members see who came in.
func (g *Gate) Redeem(txApp core.App, t Ticket) (listID string, err error) {
	switch g.Mode {
	case Open:
		return "", nil
	case Invite:
		if t.Setup != "" {
			ok, err := g.setupValid(txApp, t.Setup)
			if err != nil || ok {
				return "", err
			}
		}
		if t.Invite != "" {
			listID, live, err := invites.LiveListByHash(txApp, t.Invite)
			if err != nil || live {
				return listID, err
			}
		}
	}
	return "", ErrRefused
}

// Redeemed retires the setup link once its account is saved, so it cannot
// come back should every account later be deleted.
func (g *Gate) Redeemed(t Ticket) {
	if t.Setup == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.setupHash == t.Setup {
		g.setupHash = ""
	}
}

// setupValid reports whether h is the setup token's hash and the instance
// still has no account. Inside finish's transaction the count cannot race a
// second finish: of two visitors with the link only the first gets in.
func (g *Gate) setupValid(app core.App, h string) (bool, error) {
	g.mu.Lock()
	want := g.setupHash
	g.mu.Unlock()
	if want == "" || !pbsecurity.Equal(h, want) {
		return false, nil
	}
	n, err := app.CountRecords("accounts")
	return err == nil && n == 0, err
}
