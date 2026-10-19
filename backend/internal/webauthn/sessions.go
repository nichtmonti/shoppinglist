package webauthn

import (
	"errors"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/signup"
)

const (
	sessionTTL          = 5 * time.Minute
	sessionTypeRegister = "registration"
	sessionTypeLogin    = "login"
)

// pendingAccount is a new account between registration begin and finish,
// saved only once the ceremony succeeds (§5.4).
type pendingAccount struct {
	ID       string
	Handle   string
	Nickname string
	// Ticket is the link the account is coming in by, checked again at
	// finish ([D-241]); zero when signup needed none.
	Ticket signup.Ticket
}

// record builds the (unsaved) accounts row the pending account becomes.
func (p *pendingAccount) record(app core.App) (*core.Record, error) {
	col, err := app.FindCachedCollectionByNameOrId("accounts")
	if err != nil {
		return nil, err
	}
	rec := core.NewRecord(col)
	rec.Id = p.ID
	rec.Set("handle", p.Handle)
	rec.Set("nickname", p.Nickname)
	return rec, nil
}

// storedSession is what a ceremony carries from begin to finish.
type storedSession struct {
	Session      *webauthn.SessionData
	Pending      *pendingAccount
	FriendlyName string
}

var (
	ErrSessionNotFound    = errors.New("passkey session not found")
	ErrSessionExpired     = errors.New("passkey session expired")
	ErrCredentialNotFound = errors.New("passkey credential not found")
	// errStore marks a lookup the database failed to answer, as opposed to
	// one that found nothing.
	errStore = errors.New("passkey store lookup failed")
)

// ceremonies holds the open ceremony sessions in memory (§5.5, [D-03]): one
// per browser id and type, for sessionTTL, until a finish takes it. A restart
// drops them, and the person taps again.
type ceremonies struct {
	mu    sync.Mutex
	byKey map[ceremonyKey]ceremony
}

type ceremonyKey struct{ browserID, typ string }

type ceremony struct {
	account string // the account it was begun for; "" for a signup or a login
	session storedSession
	expires time.Time
}

// ceremoniesStoreKey names the ceremonies in the app's runtime store, so each
// app (a test's included) has its own.
const ceremoniesStoreKey = "shoppinglist_passkey_ceremonies"

func ceremoniesOf(app core.App) *ceremonies {
	return app.Store().GetOrSet(ceremoniesStoreKey, func() any {
		return &ceremonies{byKey: map[ceremonyKey]ceremony{}}
	}).(*ceremonies)
}

// createSession opens a ceremony. A re-begin supersedes a prior session of the
// SAME type, so a stale one cannot stay finishable within its TTL; the other
// type is left alone. Expired sessions go here too, so the store holds at most
// what the begin budget lets in within one TTL.
func createSession(app core.App, browserID, typ string, sd *webauthn.SessionData, pending *pendingAccount, accountID, friendlyName string) {
	c := ceremoniesOf(app)
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, v := range c.byKey {
		if now.After(v.expires) {
			delete(c.byKey, k)
		}
	}
	c.byKey[ceremonyKey{browserID, typ}] = ceremony{
		account: accountID,
		session: storedSession{Session: sd, Pending: pending, FriendlyName: friendlyName},
		expires: now.Add(sessionTTL),
	}
}

// takeSession claims the ceremony session and consumes it (single-use, §5.5).
// It is keyed by the browser id, the type (a background login/begin, [D-69],
// and a foreground registration can be in flight on one browser at once) and
// the account the session was begun for ("" for a signup or a login), so a
// caller who learned another browser's id finds nothing and cannot burn that
// account's ceremony.
func takeSession(app core.App, browserID, typ, accountID string) (*storedSession, error) {
	c := ceremoniesOf(app)
	k := ceremonyKey{browserID, typ}
	c.mu.Lock()
	got, ok := c.byKey[k]
	if ok && got.account == accountID {
		delete(c.byKey, k)
	}
	c.mu.Unlock()
	if !ok || got.account != accountID {
		return nil, ErrSessionNotFound
	}
	if time.Now().After(got.expires) {
		return nil, ErrSessionExpired
	}
	return &got.session, nil
}
