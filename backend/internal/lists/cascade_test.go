package lists

import (
	"sync"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/testutil"
)

// setupCascadeApp bootstraps a temp app with migrations applied and this
// package's hooks registered.
func setupCascadeApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	app := testutil.NewApp(t)
	Register(app)
	return app
}

// createMergeLog saves a [D-108] merge-log row for listID. Its id is a
// discarded client-minted create id, which is the collection's whole point.
func createMergeLog(t *testing.T, app core.App, listID string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("merge_log")
	if err != nil {
		t.Fatalf("find merge_log collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Id = "discarded-create-id"
	rec.Set("list", listID)
	rec.Set("survivor", "some-survivor")
	rec.Set("merged_at", types.NowDateTime())
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save merge_log: %v", err)
	}
	return rec
}

// TestLastMemberLeaveCascades (§7.3): deleting the only remaining membership
// for a list must hard-delete the list's items, list_categories, invites,
// merge_log ([D-108]) and the lists row itself.
func TestLastMemberLeaveCascades(t *testing.T) {
	app := setupCascadeApp(t)

	acctID, _ := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateList(t, app, "")
	membership := testutil.AddMembership(t, app, acctID, listID)
	testutil.CreateItem(t, app, listID, "Milk")
	testutil.CreateItem(t, app, listID, "Eggs")
	testutil.CreateListCategory(t, app, listID, "dairy")
	testutil.CreateListCategory(t, app, listID, "produce")
	testutil.CreateInvite(t, app, listID, "")
	createMergeLog(t, app, listID)

	if err := app.Delete(membership); err != nil {
		t.Fatalf("delete membership: %v", err)
	}

	if rec, err := app.FindRecordById("lists", listID); err == nil && rec != nil {
		t.Errorf("lists row %q still exists after last member left", listID)
	}
	if n := testutil.Count(t, app, "items", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("items remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "list_categories", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("list_categories remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "invites", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("invites remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "memberships", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("memberships remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "merge_log", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("merge_log rows remaining for list = %d, want 0", n)
	}
}

// TestDepartingMemberRevokesListLink ([D-31]): when a member leaves and others
// remain, the list's active link is revoked (not deleted) so the leaver — or
// anyone they shared the token with — cannot rejoin later.
//
// The invite here is created by the SURVIVING member, which is the whole point:
// the revocation is not scoped to `created_by = <the leaver>`. Scoped, a
// member who knew a link someone else minted could leave and rejoin through
// it ([D-31]); the test pins the unscoped predicate, so re-narrowing it fails
// here rather than in production.
func TestDepartingMemberRevokesListLink(t *testing.T) {
	app := setupCascadeApp(t)

	acctA, _ := testutil.CreateAccount(t, app, "Alice")
	acctB, _ := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateList(t, app, "")
	membershipA := testutil.AddMembership(t, app, acctA, listID)
	_ = testutil.AddMembership(t, app, acctB, listID)

	// One active link per list ([D-31]), minted by Bob — the member who STAYS.
	testutil.CreateInvite(t, app, listID, acctB)

	live, err := app.FindRecordsByFilter("invites", "list = {:list} && revoked = false", "", 0, 0, dbx.Params{"list": listID})
	if err != nil || len(live) != 1 {
		t.Fatalf("expected 1 live invite before the leave, got %d (err=%v)", len(live), err)
	}

	// Alice leaves.
	if err := app.Delete(membershipA); err != nil {
		t.Fatalf("delete membership: %v", err)
	}

	live, err = app.FindRecordsByFilter("invites", "list = {:list} && revoked = false", "", 0, 0, dbx.Params{"list": listID})
	if err != nil {
		t.Fatalf("query live invites: %v", err)
	}
	if len(live) != 0 {
		t.Errorf("list link still live after a member left (%d live invites); "+
			"a departing member must not keep a working link, whoever minted it", len(live))
	}

	// Revoked, not deleted — the audit row survives (§13's invite sweep collects it).
	if n := testutil.Count(t, app, "invites", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("invites rows for list = %d, want 1 (revoked, not deleted)", n)
	}

	// The list itself survives — Bob is still a member.
	if rec, err := app.FindRecordById("lists", listID); err != nil || rec == nil {
		t.Fatalf("lists row %q should still exist, got err=%v", listID, err)
	}
}

// TestNotLastMemberLeaveNoCascade (§7.3 step 1): deleting one membership out
// of two must NOT cascade — the list and its rows stay intact.
func TestNotLastMemberLeaveNoCascade(t *testing.T) {
	app := setupCascadeApp(t)

	acctA, _ := testutil.CreateAccount(t, app, "Alice")
	acctB, _ := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateList(t, app, "")
	membershipA := testutil.AddMembership(t, app, acctA, listID)
	_ = testutil.AddMembership(t, app, acctB, listID)
	testutil.CreateItem(t, app, listID, "Milk")
	testutil.CreateListCategory(t, app, listID, "dairy")

	if err := app.Delete(membershipA); err != nil {
		t.Fatalf("delete membership: %v", err)
	}

	if rec, err := app.FindRecordById("lists", listID); err != nil || rec == nil {
		t.Fatalf("lists row %q should still exist, got err=%v rec=%v", listID, err, rec)
	}
	if n := testutil.Count(t, app, "items", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("items remaining for list = %d, want 1", n)
	}
	if n := testutil.Count(t, app, "list_categories", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("list_categories remaining for list = %d, want 1", n)
	}
	if n := testutil.Count(t, app, "memberships", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("memberships remaining for list = %d, want 1", n)
	}
	if rec, err := app.FindRecordById("memberships", membershipA.Id); err == nil && rec != nil {
		t.Errorf("deleted membership %q still exists", membershipA.Id)
	}
}

// TestConcurrentDoubleLeaveLeavesNoOrphans (docs/internals/design.md §7.3,
// §14): when both remaining members leave at (almost) the same time,
// SQLite serializes the two writer transactions so exactly one of them
// observes zero remaining memberships and cascades; the end state must be
// clean regardless of which one that was — no orphaned items/categories/
// invites, no leftover memberships, the list gone exactly once, and neither
// app.Delete() call may return an unexpected error (PocketBase/SQLite may
// serialize/retry rather than error, which is also fine).
func TestConcurrentDoubleLeaveLeavesNoOrphans(t *testing.T) {
	app := setupCascadeApp(t)

	acctA, _ := testutil.CreateAccount(t, app, "Alice")
	acctB, _ := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateList(t, app, "")
	membershipA := testutil.AddMembership(t, app, acctA, listID)
	membershipB := testutil.AddMembership(t, app, acctB, listID)
	testutil.CreateItem(t, app, listID, "Milk")
	testutil.CreateItem(t, app, listID, "Eggs")
	testutil.CreateListCategory(t, app, listID, "dairy")
	testutil.CreateInvite(t, app, listID, "")

	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, 2)

	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		errs[0] = app.Delete(membershipA)
	}()
	go func() {
		defer wg.Done()
		<-start
		errs[1] = app.Delete(membershipB)
	}()
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("concurrent delete %d returned error: %v", i, err)
		}
	}

	if rec, err := app.FindRecordById("lists", listID); err == nil && rec != nil {
		t.Errorf("lists row %q still exists after both members left concurrently", listID)
	}
	if n := testutil.Count(t, app, "items", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("items remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "list_categories", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("list_categories remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "invites", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("invites remaining for list = %d, want 0", n)
	}
	if n := testutil.Count(t, app, "memberships", dbx.HashExp{"list": listID}); n != 0 {
		t.Errorf("memberships remaining for list = %d, want 0", n)
	}
}

// TestFailedCascadeKeepsTheMembership (§7.3): the cascade runs in the
// delete's transaction, so a cascade that fails rolls the leave back rather
// than leaving the list behind with no members.
func TestFailedCascadeKeepsTheMembership(t *testing.T) {
	app := setupCascadeApp(t)

	acctID, _ := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateList(t, app, "")
	membership := testutil.AddMembership(t, app, acctID, listID)
	testutil.CreateItem(t, app, listID, "Milk")
	if _, err := app.DB().NewQuery(
		"CREATE TRIGGER refuse_list_delete BEFORE DELETE ON lists BEGIN SELECT RAISE(ABORT, 'refused'); END",
	).Execute(); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	if err := app.Delete(membership); err == nil {
		t.Fatal("delete membership: want the cascade's error, got nil")
	}

	if n := testutil.Count(t, app, "memberships", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("memberships for list = %d, want 1 (the leave rolled back)", n)
	}
	if n := testutil.Count(t, app, "items", dbx.HashExp{"list": listID}); n != 1 {
		t.Errorf("items for list = %d, want 1 (the cascade rolled back)", n)
	}
}
