package webauthn

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/go-webauthn/webauthn/protocol"
	wlib "github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/members"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/records"
	"shoppinglist/internal/security"
	"shoppinglist/internal/signup"
)

// RegisterRoutes mounts the four §5.4 passkey endpoints on the serve router.
// gate decides NEW anonymous accounts only ([D-241]), so closing signup never
// locks out an existing household. The finish routes are rate-limited too
// (§10).
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent], wa *wlib.WebAuthn, gate *signup.Gate) {
	router.POST("/api/passkey/register/begin", registerBegin(wa, gate)).BindFunc(security.RateLimit(security.RatePasskeyBegin))
	router.POST("/api/passkey/register/finish", registerFinish(wa, gate)).BindFunc(security.RateLimit(security.RatePasskeyFinish))
	router.POST("/api/passkey/login/begin", loginBegin(wa)).BindFunc(security.RateLimit(security.RatePasskeyBegin))
	router.POST("/api/passkey/login/finish", loginFinish(wa)).BindFunc(security.RateLimit(security.RatePasskeyFinish))
}

// maxBrowserIDLen bounds the browser id every ceremony is keyed by: it comes
// unauthenticated and is held in memory until the finish. The client sends a
// UUID.
const maxBrowserIDLen = 128

// checkBrowserID is the 400 for a missing or over-long browser id, sent as
// `field`.
func checkBrowserID(e *core.RequestEvent, id, field string) error {
	if id != "" && len(id) <= maxBrowserIDLen {
		return nil
	}
	return e.BadRequestError(fmt.Sprintf("%s is required (at most %d bytes)", field, maxBrowserIDLen), nil)
}

type beginBody struct {
	BrowserID    string `json:"browser_id"`
	Nickname     string `json:"nickname"`
	FriendlyName string `json:"friendly_name"`
	// Invite and Setup are the links a new account may come in by under
	// SHOPPINGLIST_SIGNUP=invite ([D-241]).
	Invite string `json:"invite"`
	Setup  string `json:"setup"`
}

// readBody reads the ceremony response for go-webauthn's byte parsers and
// re-arms PocketBase's rereadable body for apis.RecordAuthResponse. A body
// past security.SmallBodyMax is PocketBase's 413.
func readBody(e *core.RequestEvent) ([]byte, error) {
	body, err := io.ReadAll(e.Request.Body)
	if err != nil {
		if apiErr, ok := errors.AsType[*router.ApiError](err); ok {
			return nil, apiErr
		}
		return nil, e.BadRequestError("invalid request body", err)
	}
	if r, ok := e.Request.Body.(router.Rereader); ok {
		r.Reread()
	}
	return body, nil
}

// verificationFailed is the 400 for a ceremony go-webauthn refused. The reason
// goes to the server log only, with a protocol.Error's DevInfo, which its
// Error() omits: told to an unauthenticated caller, which check failed (the
// expected origin and RP-ID, the challenge, the UV flag) helps tune a phishing
// relay. The client tells the failures apart by status alone.
func verificationFailed(e *core.RequestEvent, ceremony string, err error) error {
	reason := err.Error()
	if pe, ok := errors.AsType[*protocol.Error](err); ok && pe.DevInfo != "" {
		reason = pe.Details + " :: " + pe.DevInfo
	}
	// DevInfo echoes what the client sent (its origin, for one); applog
	// quotes it.
	applog.Warn(e.App, "passkey "+ceremony+" refused", nil, "reason", reason)
	return e.BadRequestError(ceremony+" verification failed", nil)
}

func registerBegin(wa *wlib.WebAuthn, gate *signup.Gate) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		var body beginBody
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("invalid request body", err)
		}
		if err := checkBrowserID(e, body.BrowserID, "browser_id"); err != nil {
			return err
		}
		// [D-08] caps from the shared contract. finish saves with
		// SaveNoValidate, so this is the only bound on the nickname every
		// co-member sees (§7.4).
		if msg := fieldcontract.OverCap("credentials", "friendly_name", body.FriendlyName); msg != "" {
			return e.BadRequestError(msg, nil)
		}
		if msg := fieldcontract.OverCap("accounts", "nickname", body.Nickname); msg != "" {
			return e.BadRequestError(msg, nil)
		}

		var (
			pending      *pendingAccount
			acctID       string
			friendlyName string
		)
		authed := security.IsAccount(e)
		if !authed && e.Request.Header.Get("Authorization") != "" {
			// An "add passkey" whose token no longer verifies (signed out
			// everywhere, expired): PocketBase leaves e.Auth nil, and the
			// signup branch below would put the passkey on a NEW account.
			// register() never sends the header, so a signup never lands here.
			return e.UnauthorizedError("the session is no longer valid", nil)
		}
		if authed {
			// Adding a passkey to an existing (authenticated) account.
			acctID = e.Auth.Id
			friendlyName = body.FriendlyName
		} else {
			// New anonymous account, the one branch the signup gate governs.
			// Checked here so a refusal comes before the passkey prompt.
			ticket, err := gate.Admit(e.App, signup.Links{Invite: body.Invite, Setup: body.Setup})
			if errors.Is(err, signup.ErrRefused) {
				return e.ForbiddenError(err.Error(), nil)
			} else if err != nil {
				return e.InternalServerError("failed to check the signup link", err)
			}
			handle := randid.Handle()
			nick := body.Nickname
			if nick == "" {
				nick = handle
			}
			// The id doubles as the WebAuthn userHandle.
			pending = &pendingAccount{ID: randid.ID(), Handle: handle, Nickname: nick, Ticket: ticket}
		}
		user, err := ceremonyUser(e, pending)
		if err != nil {
			return err
		}

		// The account's own passkeys are excluded: an authenticator that holds
		// one refuses (InvalidStateError) instead of replacing it in place,
		// which would leave a credentials row no key can use, and the
		// last-passkey guard counting it.
		creation, sd, err := wa.BeginRegistration(user,
			wlib.WithExclusions(wlib.Credentials(user.WebAuthnCredentials()).CredentialDescriptors()))
		if err != nil {
			return e.InternalServerError("failed to begin registration", err)
		}
		createSession(e.App, body.BrowserID, sessionTypeRegister, sd, pending, acctID, friendlyName)
		return e.JSON(http.StatusOK, creation)
	}
}

// requireBrowserID reads the X-Browser-Id header both finish ceremonies are
// keyed by (§5.5).
func requireBrowserID(e *core.RequestEvent) (string, error) {
	browserID := e.Request.Header.Get("X-Browser-Id")
	return browserID, checkBrowserID(e, browserID, "X-Browser-Id header")
}

// consumeSession claims the ceremony session begun for accountID, consuming
// it (single-use, §5.5): a replayed or concurrent finish, or one by anyone
// else, then finds no session and is rejected.
func consumeSession(e *core.RequestEvent, browserID, st, accountID string) (*storedSession, error) {
	s, err := takeSession(e.App, browserID, st, accountID)
	if err != nil {
		return nil, e.BadRequestError("session not found or expired", err)
	}
	return s, nil
}

// ceremonyUser is the accountUser a registration is begun and verified
// against: a brand-new account from `pending`, or with none the caller's own
// account when adding a passkey (in finish, takeSession matched it).
func ceremonyUser(e *core.RequestEvent, pending *pendingAccount) (*accountUser, error) {
	if pending != nil {
		rec, err := pending.record(e.App)
		if err != nil {
			return nil, e.InternalServerError("accounts collection missing", err)
		}
		return newAccountUser(rec, nil), nil
	}
	creds, err := loadCredentials(e.App, e.Auth.Id)
	if err != nil {
		return nil, e.InternalServerError("failed to load passkeys", err)
	}
	return newAccountUser(e.Auth, creds), nil
}

func registerFinish(wa *wlib.WebAuthn, gate *signup.Gate) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		browserID, err := requireBrowserID(e)
		if err != nil {
			return err
		}
		body, err := readBody(e)
		if err != nil {
			return err
		}
		// An added passkey's session is the signed-in caller's; a signup's
		// belongs to no account.
		owner := ""
		if security.IsAccount(e) {
			owner = e.Auth.Id
		}
		s, err := consumeSession(e, browserID, sessionTypeRegister, owner)
		if err != nil {
			return err
		}

		user, err := ceremonyUser(e, s.Pending)
		if err != nil {
			return err
		}

		parsed, err := protocol.ParseCredentialCreationResponseBytes(body)
		if err != nil {
			return verificationFailed(e, "registration", err)
		}
		cred, err := wa.CreateCredential(user, *s.Session, parsed)
		if err != nil {
			return verificationFailed(e, "registration", err)
		}

		if s.Pending != nil {
			// Persist account + credential atomically (§5.4). The gate is
			// checked again inside that transaction, not trusted from begin: a
			// session outlives a restart that closed signup, and a link can be
			// revoked or expire mid-ceremony.
			ticket := s.Pending.Ticket
			err := persistNewAccountAndCredential(e.App, user.record, cred, func(txApp core.App) (string, error) {
				return gate.Redeem(txApp, ticket)
			})
			if errors.Is(err, signup.ErrRefused) {
				return e.ForbiddenError(err.Error(), nil)
			} else if err != nil {
				return e.InternalServerError("failed to persist account", err)
			}
			gate.Redeemed(ticket)
			return apis.RecordAuthResponse(e, user.record, "passkey", nil)
		}
		if err := persistCredential(e.App, user.record.Id, cred, s.FriendlyName); err != nil {
			return e.InternalServerError("failed to persist credential", err)
		}
		return e.JSON(http.StatusOK, map[string]any{"ok": true})
	}
}

func loginBegin(wa *wlib.WebAuthn) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		var body beginBody
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("invalid request body", err)
		}
		if err := checkBrowserID(e, body.BrowserID, "browser_id"); err != nil {
			return err
		}
		// User verification is required by the config (New), which both
		// ceremonies take it from.
		assertion, sd, err := wa.BeginDiscoverableLogin()
		if err != nil {
			return e.InternalServerError("failed to begin login", err)
		}
		createSession(e.App, body.BrowserID, sessionTypeLogin, sd, nil, "", "")
		return e.JSON(http.StatusOK, assertion)
	}
}

// resolveUserFromCredential resolves the account from the OWNER OF THE
// ASSERTED CREDENTIAL, never from userHandle: the client supplies that handle
// outside the signature, so trusting it lets the caller pick its account.
// Derived this way, go-webauthn's handle-equals-WebAuthnID check becomes a
// real assertion. The handle compared is the one the credential was
// registered under (credentials.user_handle, [D-153]), since a link moves
// credentials between accounts.
//
// A lookup that failed is wrapped in errStore: it says nothing about the
// passkey, so it must not reach the client as "unknown passkey" ([D-191]).
func resolveUserFromCredential(e *core.RequestEvent, rawID, userHandle []byte) (wlib.User, error) {
	credRec, err := findCredential(e.App, rawID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errStore, err)
	}
	if credRec == nil {
		return nil, ErrCredentialNotFound
	}
	rec, err := records.FindOptional(e.App, "accounts", credRec.GetString("account"))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errStore, err)
	}
	if rec == nil {
		return nil, ErrCredentialNotFound
	}
	creds, err := loadCredentials(e.App, rec.Id)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errStore, err)
	}
	user := newAccountUser(rec, creds)
	user.handle = credRec.GetString("user_handle")
	return user, nil
}

func loginFinish(wa *wlib.WebAuthn) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		browserID, err := requireBrowserID(e)
		if err != nil {
			return err
		}
		body, err := readBody(e)
		if err != nil {
			return err
		}
		s, err := consumeSession(e, browserID, sessionTypeLogin, "")
		if err != nil {
			return err
		}

		parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
		if err != nil {
			return verificationFailed(e, "login", err)
		}
		user, cred, err := wa.ValidatePasskeyLogin(
			func(rawID, userHandle []byte) (wlib.User, error) {
				return resolveUserFromCredential(e, rawID, userHandle)
			}, *s.Session, parsed)
		if errors.Is(err, errStore) {
			return e.InternalServerError("failed to look up the passkey", err)
		}
		if errors.Is(err, ErrCredentialNotFound) {
			// A passkey removed from the account (or with it) that the device
			// still offers: a 404, so the client can say so and ask the
			// browser to forget it, instead of a retry that never works.
			return e.NotFoundError("unknown passkey", nil)
		}
		if err != nil {
			return verificationFailed(e, "login", err)
		}
		// The user the login handler returned, which is always an accountUser.
		au := user.(*accountUser)
		if err := updateCredential(e.App, cred); err != nil {
			return e.InternalServerError("failed to update credential", err)
		}
		return apis.RecordAuthResponse(e, au.record, "passkey", nil)
	}
}

// persistNewAccountAndCredential saves the account and the verified
// credential in one transaction (§5.4). admit runs first, inside it: it
// refuses (signup.ErrRefused) or names the list to join ("" for none), so an
// account that came by a list's link is never saved without its membership
// ([D-241]).
func persistNewAccountAndCredential(app core.App, acct *core.Record, cred *wlib.Credential, admit func(core.App) (string, error)) error {
	return app.RunInTransaction(func(txApp core.App) error {
		listID, err := admit(txApp)
		if err != nil {
			return err
		}
		acct.SetRandomPassword()
		if err := txApp.SaveNoValidate(acct); err != nil {
			return err
		}
		if err := persistCredential(txApp, acct.Id, cred, ""); err != nil {
			return err
		}
		if listID != "" {
			_, err = members.Add(txApp, acct.Id, listID)
		}
		return err
	})
}

// persistCredential stores one passkey as a credentials row; credential_json
// is the full struct, for lossless round-trips (§6.2).
func persistCredential(app core.App, accountID string, cred *wlib.Credential, friendlyName string) error {
	col, err := app.FindCachedCollectionByNameOrId("credentials")
	if err != nil {
		return err
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	rec := core.NewRecord(col)
	rec.Set("account", accountID)
	// The user.id embedded in the passkey, kept when a link moves the row
	// ([D-153]).
	rec.Set("user_handle", accountID)
	rec.Set("credential_id", base64.RawURLEncoding.EncodeToString(cred.ID))
	rec.Set("credential_json", raw)
	rec.Set("friendly_name", friendlyName)
	rec.Set("last_used_at", types.NowDateTime())
	return app.SaveNoValidate(rec)
}

// updateCredential refreshes the stored sign-count and last_used_at after a
// login. go-webauthn's clone signal (the counter did not advance) is logged,
// never enforced: the signal is advisory, and refusing would lock a real user
// out of a real passkey on a malfunctioning authenticator.
func updateCredential(app core.App, cred *wlib.Credential) error {
	rec, err := findCredential(app, cred.ID)
	if err != nil || rec == nil {
		return err
	}
	if cred.Authenticator.CloneWarning {
		applog.Warn(app, "passkey signature counter did not advance — the authenticator may be cloned", nil,
			"credential", rec.Id, "account", rec.GetString("account"), "sign_count", cred.Authenticator.SignCount)
	}
	// go-webauthn only ever sets the flag and stores it with the credential,
	// so kept it would report every later login of this key as cloned too.
	cred.Authenticator.CloneWarning = false
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	rec.Set("credential_json", raw)
	rec.Set("last_used_at", types.NowDateTime())
	return app.SaveNoValidate(rec)
}

// findCredential returns the credentials row for a WebAuthn credential id
// (stored as its base64url), or nil when no row has it.
func findCredential(app core.App, id []byte) (*core.Record, error) {
	return records.FindFirstOptional(app, "credentials", dbx.HashExp{"credential_id": base64.RawURLEncoding.EncodeToString(id)})
}
