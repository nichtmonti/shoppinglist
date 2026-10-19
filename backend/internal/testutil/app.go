// Package testutil provides shared test scaffolding for backend integration
// tests: a temp-dir PocketBase app with all collection migrations applied,
// routes mounted on it, and the rows tests start from.
package testutil

import (
	"testing"

	"github.com/pocketbase/pocketbase"

	"shoppinglist/internal/testutil/testapp"
)

// NewApp is testapp.New. Callers register whatever routes/hooks their package
// under test needs on top (see shoppinglist/internal/webauthn's
// setupWebauthnApp for the pattern when a package also needs its own
// env/config setup).
func NewApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	return testapp.New(t)
}
