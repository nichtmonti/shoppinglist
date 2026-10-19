package seed_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"shoppinglist/internal/testutil"
	"shoppinglist/seed"
)

func setupSeedApp(t *testing.T) http.Handler {
	t.Helper()
	_, mux := testutil.NewMux(t, seed.RegisterRoutes)
	return mux
}

// TestSeedVersion_Unauthenticated: no Authorization → 401.
func TestSeedVersion_Unauthenticated(t *testing.T) {
	mux := setupSeedApp(t)
	rec, _ := testutil.DoReq(mux, http.MethodGet, "/api/seed-version", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

// TestSeedVersion_ReturnsVersion: authenticated GET → 200 with {"version": seed.CurrentSeedVersion}.
func TestSeedVersion_ReturnsVersion(t *testing.T) {
	app, mux := testutil.NewMux(t, seed.RegisterRoutes)
	_, tok := testutil.CreateAccount(t, app, "Alice")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/seed-version", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	version, ok := resp["version"]
	if !ok {
		t.Fatal("response missing 'version' field")
	}

	expected := seed.CurrentSeedVersion
	if version != expected {
		t.Errorf("version = %s, want %s", version, expected)
	}
}
