package migrations

import (
	"fmt"
	"testing"

	"github.com/pocketbase/pocketbase"
)

// newMigratedApp bootstraps a temp app with every migration applied.
// testutil.NewApp is the usual way, but it imports this package — a test here
// cannot import it back — so the few lines are inlined.
func newMigratedApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return app
}

// insertInvite writes an invites row through raw SQL, bypassing the record
// pipeline so the DB constraints are what is actually under test.
func insertInvite(app *pocketbase.PocketBase, list, hash, created string, revoked int) error {
	_, err := app.DB().NewQuery(fmt.Sprintf(
		`INSERT INTO invites (id, list, token_hash, revoked, created, updated, expires_at)
		 VALUES ('%s_id_padding_x', '%s', '%s', %d, '%s', '%s', '2099-01-01 00:00:00.000Z')`,
		hash, list, hash, revoked, created, created)).Execute()
	return err
}

const (
	listA = "listAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	listB = "listBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	listC = "listCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
)

// TestInvitesOneActivePerListEnforced ([D-31]): the partial unique index is
// real in SQLite, not just collection metadata: it is what makes "one active
// link per list" hold whatever the client does.
func TestInvitesOneActivePerListEnforced(t *testing.T) {
	app := newMigratedApp(t)

	var ddl string
	if err := app.DB().NewQuery(
		"SELECT COALESCE(sql,'') FROM sqlite_master WHERE type='index' AND name={:n}").
		Bind(map[string]any{"n": inviteActiveIndex}).Row(&ddl); err != nil {
		t.Fatalf("index %s not found in sqlite_master: %v", inviteActiveIndex, err)
	}

	if err := insertInvite(app, listA, "x1", "2026-01-01 00:00:00.000Z", 0); err != nil {
		t.Fatalf("first live invite rejected: %v", err)
	}
	if err := insertInvite(app, listA, "x2", "2026-02-01 00:00:00.000Z", 0); err == nil {
		t.Error("a SECOND live invite was accepted on the same list — the index is not enforcing")
	}
	// Revoked rows are excluded from the index, so any number may pile up
	// (§13's invite sweep collects them; the audit trail wants them kept).
	if err := insertInvite(app, listA, "x3", "2026-03-01 00:00:00.000Z", 1); err != nil {
		t.Errorf("revoked invite rejected: %v — the index must be partial", err)
	}
	if err := insertInvite(app, listA, "x4", "2026-04-01 00:00:00.000Z", 1); err != nil {
		t.Errorf("second revoked invite rejected: %v", err)
	}
}

// TestInvitesCollapseExistingRows ([D-31]): the up migration runs against
// DEPLOYED data, where a list may already carry several live invites — the
// state the new index would reject. The newest survives (it is the one the
// share sheet was displaying); the rest are revoked, not deleted.
func TestInvitesCollapseExistingRows(t *testing.T) {
	app := newMigratedApp(t)

	// Recreate the pre-migration state: drop the index, then write rows that
	// violate it. PocketBase syncs index DDL from collection metadata only when
	// that metadata changes, so the collection is reset to its old index list
	// first — otherwise the re-run below is a no-op and the index never returns.
	col, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		t.Fatalf("find invites: %v", err)
	}
	col.Indexes = col.Indexes[:1] // token_hash only, i.e. pre-1778000007
	if err := app.Save(col); err != nil {
		t.Fatalf("reset indexes: %v", err)
	}

	for _, r := range []struct {
		list, hash, created string
		revoked             int
	}{
		{listA, "a1", "2026-01-01 00:00:00.000Z", 0},
		{listA, "a2", "2026-03-01 00:00:00.000Z", 0}, // newest live → survives
		{listA, "a3", "2026-02-01 00:00:00.000Z", 0},
		{listB, "b1", "2026-01-01 00:00:00.000Z", 0}, // sole live → untouched
		{listC, "c1", "2026-01-01 00:00:00.000Z", 1}, // already revoked
	} {
		if err := insertInvite(app, r.list, r.hash, r.created, r.revoked); err != nil {
			t.Fatalf("seed %s: %v", r.hash, err)
		}
	}

	if err := invitesServerOnlyUp(app); err != nil {
		t.Fatalf("migration failed against existing data: %v", err)
	}

	var survivor string
	if err := app.DB().NewQuery(
		"SELECT token_hash FROM invites WHERE list = {:l} AND revoked = 0").
		Bind(map[string]any{"l": listA}).Row(&survivor); err != nil {
		t.Fatalf("list A has no surviving live invite: %v", err)
	}
	if survivor != "a2" {
		t.Errorf("list A survivor = %q, want %q (the newest live invite)", survivor, "a2")
	}

	var kept int
	_ = app.DB().NewQuery("SELECT COUNT(*) FROM invites WHERE list = {:l}").
		Bind(map[string]any{"l": listA}).Row(&kept)
	if kept != 3 {
		t.Errorf("list A rows = %d, want 3 — collapsed invites are revoked, never deleted", kept)
	}

	var liveB int
	_ = app.DB().NewQuery("SELECT COUNT(*) FROM invites WHERE list = {:l} AND revoked = 0").
		Bind(map[string]any{"l": listB}).Row(&liveB)
	if liveB != 1 {
		t.Errorf("list B live invites = %d, want 1 — a single-invite list must be untouched", liveB)
	}

	// Idempotent: migrations get re-run in tests and on repaired databases.
	if err := invitesServerOnlyUp(app); err != nil {
		t.Errorf("re-running the migration failed: %v", err)
	}
}
