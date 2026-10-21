// The [D-76] OIDC auto-create hook.
//
// PocketBase's OAuth2 first login creates the account through the record
// create pipeline as the anonymous visitor, which accounts.CreateRule
// (superuser-only: account creation is gated by passkey possession) refuses.
// The hook therefore pre-creates the record at system level; with e.Record
// set, PocketBase takes its existing-record branch, which links the
// ExternalAuth row and mints the token. The name → nickname mapping is
// applied here instead of through MappedFields.
//
// The pre-create shares ONE transaction with PocketBase's exchange (the hook
// sets e.App to it before e.Next(), and oauth2Submit's RunInTransaction joins
// it), so a failed exchange rolls the account back instead of leaving an
// identity-less row that, with no email stored, nothing could reuse.
//
// # No email is stored ([D-25])
//
// The hook clears the provider-asserted email from e.OAuth2User before
// PocketBase sees it: oauth2Submit copies it onto a new record and onto an
// existing one with an empty email, and this is the one point covering both.
// The account stays `verified`, because PocketBase treats an unverified
// record on this path as possibly pre-hijacked and deletes its ExternalAuth
// links on every login.
//
// # The hook is also the identity gate
//
// PocketBase resolves the record BEFORE this hook runs, in three steps
// (apis/record_auth_with_oauth2.go):
//
//  1. the ExternalAuth row for (collection, provider, sub): the real identity;
//  2. FALLBACK: the account the request's own Authorization header names;
//  3. FALLBACK: any account holding the provider-asserted email.
//
// Neither fallback proves the subject owns that account, and both are
// reachable: (2) whenever the §5.9 link flow runs from a browser signed in as
// the passkey account, (3) is the email auto-merge [D-76] rules out, held off
// otherwise only by a unique index a second provider would bypass.
//
// So the hook accepts (1) only: an OIDC login resolves to the account that
// owns the subject or to a fresh one, never to an account the caller merely
// holds a token for or shares an address with. Linking an existing account
// stays explicit: POST /api/account/link with BOTH sessions ([D-76]).

package oidc

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/oidclogin"
)

// Register binds the auto-create hook on the accounts collection. It must
// run after the migrations created the collection.
func Register(app core.App) {
	app.OnRecordAuthWithOAuth2Request("accounts").Bind(&hook.Handler[*core.RecordAuthWithOAuth2RequestEvent]{
		Id:   "shoppinglist_oidc_autocreate",
		Func: autoCreateRecord,
	})
}

func autoCreateRecord(e *core.RecordAuthWithOAuth2RequestEvent) error {
	// Cleared before anything reads it; the address is never persisted
	// ([D-25]).
	email := e.OAuth2User.Email
	e.OAuth2User.Email = ""
	// The settings label may fall back to the address, which only this hook
	// still holds ([D-76]).
	label := identityLabel(e.OAuth2User.Username, email)

	owns, err := ownsIdentity(e.App, e.Collection.Id, e.ProviderName, e.OAuth2User.Id, e.Record)
	if err != nil {
		return e.InternalServerError("failed to look up the OIDC identity", err)
	}
	if owns {
		// The subject's own account. The label is refreshed on every sign-in,
		// so a renamed username shows up.
		if err := e.Next(); err != nil {
			return err
		}
		storeIdentity(e.App, e.Record.Id, label)
		return nil
	}

	// Anything else came from one of PocketBase's fallbacks (see the package
	// comment) and is not this subject: create the subject's own account.
	return e.App.RunInTransaction(func(txApp core.App) error {
		rec := core.NewRecord(e.Collection)
		// Verified despite having no email: see the package comment.
		rec.SetVerified(true)
		rec.Set("nickname", displayName(e.OAuth2User.Name, e.OAuth2User.Username, email))
		// OIDC-born accounts have no handle (§6.1); the unique handle index is
		// partial (handle != ''), so any number of them coexist.
		rec.Set("handle", nil)
		// Satisfies the auth schema; unusable, since PasswordAuth is disabled.
		rec.SetRandomPassword()
		if err := txApp.Save(rec); err != nil {
			return err
		}

		// The rest of the chain runs in the transaction, as PocketBase's own
		// hooks do it, and the event gets its app back after.
		original := e.App
		e.App = txApp
		defer func() { e.App = original }()
		e.Record = rec
		e.IsNewRecord = true
		if err := e.Next(); err != nil {
			return err
		}
		storeIdentity(txApp, rec.Id, label)
		return nil
	})
}

// storeIdentity records the settings label for accountID. A failure is logged
// and swallowed: a completed sign-in must not fail over display data.
func storeIdentity(app core.App, accountID, label string) {
	if err := oidclogin.SetIdentity(app, accountID, label); err != nil {
		applog.Warn(app, "OIDC: storing the identity label failed", err, "account", accountID)
	}
}

// identityLabel is what settings shows the OIDC login as ([D-76]): the
// provider's preferred_username, else the asserted address, else "". It is
// stored in oidc_identities, never on the account.
func identityLabel(username, email string) string {
	return fieldcontract.CutBytes(firstNonBlank(username, email), oidclogin.MaxIdentityBytes)
}

// ownsIdentity reports whether rec is the account the ExternalAuth row for
// this (collection, provider, subject) points at, i.e. whether PocketBase
// resolved it from the identity rather than a fallback. A missing row must
// answer false; a failed lookup is an error, never "not this subject"
// ([D-191]).
func ownsIdentity(app core.App, collectionID, provider, subject string, rec *core.Record) (bool, error) {
	if rec == nil || subject == "" {
		return false, nil
	}
	// The lookup PocketBase's own OAuth2 route makes, so this judges the row
	// it resolved.
	rel, err := app.FindFirstExternalAuthByExpr(dbx.HashExp{
		"collectionRef": collectionID,
		"provider":      provider,
		"providerId":    subject,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return rel.RecordRef() == rec.Id, nil
}

// displayName picks the new account's nickname: the first non-blank of the
// name claim, the username and the email's local part, or "" (the client
// renders a localized placeholder). It is cut to the contract's nickname cap
// ([D-08]) because PocketBase's own validation on this path allows far more.
func displayName(name, username, email string) string {
	local, _, _ := strings.Cut(email, "@")
	return fieldcontract.Truncate("accounts", "nickname", firstNonBlank(name, username, local))
}

// firstNonBlank is the first of candidates with more than spaces, trimmed, or "".
func firstNonBlank(candidates ...string) string {
	for _, candidate := range candidates {
		if c := strings.TrimSpace(candidate); c != "" {
			return c
		}
	}
	return ""
}
