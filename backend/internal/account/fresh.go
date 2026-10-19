package account

import (
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	pbsecurity "github.com/pocketbase/pocketbase/tools/security"
)

// [D-309] Deleting the account wants a sign-in from moments ago, so a stolen
// token alone, even a refreshed one, cannot delete it.

// freshSignIn is how long ago that sign-in may be: the client signs in right
// before it deletes.
const freshSignIn = 5 * time.Minute

// claimAuthTime is the time of the sign-in a token came from, in Unix seconds,
// named after OIDC's claim for the same. auth-refresh mints its token without
// it, so a refreshed token never reads as fresh.
const claimAuthTime = "auth_time"

// stampAuthTime adds claimAuthTime to the token of every sign-in: a passkey,
// an OIDC exchange, a demo start. The auth responses with no method,
// auth-refresh and a superuser's impersonate, keep PocketBase's token. The
// rest of the claims, the expiry and the signing key are PocketBase's own.
func stampAuthTime(e *core.RecordAuthRequestEvent) error {
	if e.AuthMethod != "" {
		claims, err := pbsecurity.ParseUnverifiedJWT(e.Token)
		if err != nil {
			return err
		}
		claims[claimAuthTime] = time.Now().Unix()
		col := e.Record.Collection()
		if e.Token, err = pbsecurity.NewJWT(claims, e.Record.TokenKey()+col.AuthToken.Secret, col.AuthToken.DurationTime()); err != nil {
			return err
		}
	}
	return e.Next()
}

// requireFreshSignIn refuses a request whose token comes from no sign-in in
// the last freshSignIn. An account with no way in (waysIn: a demo account,
// [D-234], or one whose methods the instance switched off) has nothing to sign
// in with, so its token is enough.
func requireFreshSignIn(e *core.RequestEvent, passkeysOn bool) error {
	passkeys, oidc, err := waysIn(e.App, e.Auth, passkeysOn)
	if err != nil {
		return e.InternalServerError("failed to load the account's logins", err)
	}
	if passkeys == 0 && !oidc {
		return nil
	}
	// Unverified is enough: PocketBase set e.Auth from this header after
	// checking its signature, as its own auth-refresh reads it.
	// The "Bearer " prefix is optional and its case free, as PocketBase reads it.
	token := e.Request.Header.Get("Authorization")
	if len(token) > 7 && strings.EqualFold(token[:7], "Bearer ") {
		token = token[7:]
	}
	claims, err := pbsecurity.ParseUnverifiedJWT(token)
	if at, ok := claims[claimAuthTime].(float64); err == nil && ok &&
		time.Since(time.Unix(int64(at), 0)) <= freshSignIn {
		return nil
	}
	return e.ForbiddenError("sign in again first: this needs a sign-in from the last 5 minutes", nil)
}
