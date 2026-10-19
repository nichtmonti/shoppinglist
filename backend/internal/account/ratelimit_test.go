package account

import (
	"net/http"
	"testing"

	"shoppinglist/internal/testutil"
)

// The §10 budgets for the account-lifecycle routes.
//
// delete, link, unlink and rotate-token-key share ONE bucket on purpose: they
// are the same act at four depths (end this session everywhere, attach a
// login, drop a login, end the account), a human performs any of them a
// handful of times ever, and one bucket means someone holding a stolen token
// cannot get four times the attempts by rotating between them. rename is separate — it is an
// ordinary edit a user may repeat while tidying up their passkey list.

// TestAccountWriteRoutesShareOneBudget spends the shared bucket through link,
// which is the only one of the three that can be called repeatedly without
// destroying the session doing the calling: a bad target token is refused by
// the HANDLER (401), so the limiter has already counted the attempt.
func TestAccountWriteRoutesShareOneBudget(t *testing.T) {
	app, mux := setupDeleteApp(t)
	setOidc(t, app, true) // the link route exists only while OIDC is on ([D-76])
	_, tok := testutil.CreateAccount(t, app, "Anna")

	const quota = 10
	for i := range quota {
		rec, body := testutil.DoReq(mux, http.MethodPost, "/api/account/link",
			`{"token":"not-a-real-token"}`, testutil.AuthHeader(tok))
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("link %d of %d: rate-limited too early: %s", i+1, quota, body)
		}
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("link %d = %d, want 401 (spent, not settled): %s", i+1, rec.Code, body)
		}
	}

	// Spent for the whole family, not just for the route that spent it — and
	// delete comes last, because a 200 there would end the account.
	for _, path := range []string{
		"/api/account/link",
		"/api/account/unlink",
		"/api/account/rotate-token-key",
		"/api/account/delete",
	} {
		rec, body := testutil.DoReq(mux, http.MethodPost, path, `{}`, testutil.AuthHeader(tok))
		if rec.Code != http.StatusTooManyRequests {
			t.Errorf("%s after the shared budget was spent = %d, want 429: %s",
				path, rec.Code, body)
		}
	}
}

func TestRenameCredentialRateLimit(t *testing.T) {
	app, mux := setupAccountApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Anna")
	cred := testutil.CreateCredential(t, app, acctID)

	const quota = 30
	call := func() int {
		rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/credentials/"+cred.Id+"/rename",
			`{"friendly_name":"Pixel"}`, testutil.AuthHeader(tok))
		return rec.Code
	}
	for i := range quota {
		if code := call(); code == http.StatusTooManyRequests {
			t.Fatalf("rename %d of %d: rate-limited too early", i+1, quota)
		}
	}
	if code := call(); code != http.StatusTooManyRequests {
		t.Errorf("rename %d status = %d, want 429", quota+1, code)
	}
}
