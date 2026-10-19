package sectest

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/security"
	"shoppinglist/internal/signup"
	"shoppinglist/internal/testutil"
	wa "shoppinglist/internal/webauthn"
)

// TestExploitFullAccountTakeover is the end-to-end regression for the pre-ship
// account-takeover chain, driven by a software authenticator (testutil) so the
// assertion is genuinely signed rather than stubbed.
//
// Mallory holds a passkey of her own. She (1) PATCHes her credentials row so it
// belongs to the victim, then (2) completes a discoverable login signed with her
// OWN private key but with `response.userHandle` rewritten to the victim's
// account id. A server that resolved the account from that handle would find
// Mallory's reparented credential in the victim's credential list, verify the
// signature against Mallory's own public key, and mint an auth token for the
// VICTIM.
//
// Both halves are independently fatal to the attack, and this test asserts
// both: step 1 is refused outright (migration 1778000003), and step 2 is
// refused even if step 1 ever regresses, because loginFinish derives the
// account from the credential's owner rather than the unsigned,
// client-supplied userHandle.
func TestExploitFullAccountTakeover(t *testing.T) {
	t.Setenv("SHOPPINGLIST_RP_ID", "localhost")
	t.Setenv("SHOPPINGLIST_RP_ORIGIN", "https://localhost")

	app := testutil.NewApp(t)
	cfg, err := wa.FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	w, err := wa.New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	wa.RegisterRoutes(security.AppRoutes(router), w, signup.NewGate(signup.Open))
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}

	victimID, _ := testutil.CreateAccount(t, app, "Victim")
	malloryID, malloryTok := testutil.CreateAccount(t, app, "Mallory")

	// Mallory's passkey, as if registered normally.
	key := testutil.NewAuthenticator(t, "localhost", "https://localhost")
	key.UserHandle = []byte(malloryID)
	credCol, _ := app.FindCollectionByNameOrId("credentials")
	credRec := core.NewRecord(credCol)
	credRec.Set("account", malloryID)
	credRec.Set("user_handle", malloryID)
	credRec.Set("credential_id", base64.RawURLEncoding.EncodeToString(key.CredentialID))
	credRec.Set("credential_json", key.CredentialJSON())
	if err := app.SaveNoValidate(credRec); err != nil {
		t.Fatalf("save cred: %v", err)
	}

	// STEP 1 — reparent the credential onto the victim via the public REST API.
	code, body := do(mux, http.MethodPatch,
		"/api/collections/credentials/records/"+credRec.Id,
		`{"account":"`+victimID+`"}`, malloryTok)
	if code == 200 {
		t.Errorf("EXPLOITED: credential reparented onto victim -> %d %s", code, body)
	} else {
		t.Logf("step 1 BLOCKED (reparent refused): %d %s", code, body)
	}

	// STEP 2 — a discoverable login signed with MALLORY's key that claims the
	// VICTIM's handle.
	login := func(browserID string) (int, string) {
		code, begin := do(mux, http.MethodPost, "/api/passkey/login/begin", `{"browser_id":"`+browserID+`"}`, "")
		if code != 200 {
			t.Fatalf("login/begin: %d %s", code, begin)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/passkey/login/finish", strings.NewReader(key.Assert(t, begin)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Browser-Id", browserID)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var out struct {
			Record struct {
				ID string `json:"id"`
			} `json:"record"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out.Record.ID
	}
	key.UserHandle = []byte(victimID) // <-- forged, never signed
	code, signedIn := login("mallory-forged")
	if code == 200 && signedIn == victimID {
		t.Errorf("EXPLOITED: full account takeover — Mallory's passkey signed in as the victim %s", victimID)
	}

	// The control: the same passkey with its true handle signs in as Mallory,
	// so the refusal above is the check and not a broken ceremony.
	key.UserHandle = []byte(malloryID)
	if code, signedIn := login("mallory-genuine"); code != 200 || signedIn != malloryID {
		t.Errorf("Mallory's genuine login = %d as %q, want 200 as herself", code, signedIn)
	}
}
