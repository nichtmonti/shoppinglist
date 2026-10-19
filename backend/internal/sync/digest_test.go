package sync

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// TestDigest_Unauthenticated: no Authorization → 401.
func TestDigest_Unauthenticated(t *testing.T) {
	_, mux := setupSyncApp(t)
	rec, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

// TestDigest_EmptyForMember: a member with a list but NO items/categories →
// returns one entry with row_count 0, max_updated "", and the empty-input sha256 hash.
func TestDigest_EmptyForMember(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}

	var entries []digestEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(entries) != 1 {
		t.Fatalf("entries count = %d, want 1", len(entries))
	}

	entry := entries[0]
	if entry.ListID != listID {
		t.Errorf("list_id = %s, want %s", entry.ListID, listID)
	}
	if entry.RowCount != 0 {
		t.Errorf("row_count = %d, want 0", entry.RowCount)
	}
	if entry.MaxUpdated != "" {
		t.Errorf("max_updated = %s, want empty", entry.MaxUpdated)
	}
	// SHA-256 of empty string
	if entry.Hash != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("hash = %s, want empty sha256", entry.Hash)
	}
}

// TestDigest_Aggregates: seed a list, add an "other" category + one item via direct DB writes;
// GET digest → entry has row_count==2, max_updated is non-empty (the max of the two rows' updated), and hash is non-empty.
func TestDigest_Aggregates(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Add an "other" category
	catID := seedOtherCategory(t, app, listID)

	// Add an item
	itemCol, _ := app.FindCollectionByNameOrId("items")
	itemRec := core.NewRecord(itemCol)
	itemRec.Id = randid.ID()
	itemRec.Set("list", listID)
	itemRec.Set("name", "Milk")
	if err := app.SaveNoValidate(itemRec); err != nil {
		t.Fatalf("save item: %v", err)
	}

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}

	var entries []digestEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(entries) != 1 {
		t.Fatalf("entries count = %d, want 1", len(entries))
	}

	entry := entries[0]
	if entry.ListID != listID {
		t.Errorf("list_id = %s, want %s", entry.ListID, listID)
	}
	if entry.RowCount != 2 {
		t.Errorf("row_count = %d, want 2", entry.RowCount)
	}
	if entry.MaxUpdated == "" {
		t.Errorf("max_updated should be non-empty")
	}
	if entry.Hash == "" {
		t.Errorf("hash should be non-empty")
	}

	// Verify the records are included
	catRec, _ := app.FindRecordById(collectionCategories, catID)
	itemRecDB, _ := app.FindRecordById(collectionItems, itemRec.Id)
	if catRec == nil || itemRecDB == nil {
		t.Fatal("records should exist")
	}

	// Compute expected hash manually
	rows := []*core.Record{catRec, itemRecDB}
	keys := make([]rowKey, len(rows))
	for i, r := range rows {
		keys[i] = rowKey{Id: r.Id, Updated: r.GetString("updated")}
	}
	expectedHash, rowCount, _ := digestOf(keys)
	if rowCount != 2 {
		t.Errorf("computed row_count = %d, want 2", rowCount)
	}
	if entry.Hash != expectedHash {
		t.Errorf("hash mismatch: got %s, want %s", entry.Hash, expectedHash)
	}
}

// TestDigest_HashMatchesAcrossMembers: two members of the SAME list both GET digest →
// identical hash and row_count for that list (the digest is membership-independent).
func TestDigest_HashMatchesAcrossMembers(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")
	addMembership(t, app, acctB, listID)

	// Add an item
	itemCol, _ := app.FindCollectionByNameOrId("items")
	itemRec := core.NewRecord(itemCol)
	itemRec.Id = randid.ID()
	itemRec.Set("list", listID)
	itemRec.Set("name", "Milk")
	if err := app.SaveNoValidate(itemRec); err != nil {
		t.Fatalf("save item: %v", err)
	}

	// Alice's digest
	recA, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tokA))
	if recA.Code != http.StatusOK {
		t.Fatalf("A status = %d: %s", recA.Code, recA.Body.String())
	}
	var entriesA []digestEntry
	json.Unmarshal(recA.Body.Bytes(), &entriesA)

	// Bob's digest
	recB, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tokB))
	if recB.Code != http.StatusOK {
		t.Fatalf("B status = %d: %s", recB.Code, recB.Body.String())
	}
	var entriesB []digestEntry
	json.Unmarshal(recB.Body.Bytes(), &entriesB)

	if len(entriesA) != 1 || len(entriesB) != 1 {
		t.Fatalf("entries count: A=%d, B=%d, want 1 each", len(entriesA), len(entriesB))
	}

	entryA := entriesA[0]
	entryB := entriesB[0]

	if entryA.Hash != entryB.Hash {
		t.Errorf("hash mismatch: A=%s, B=%s", entryA.Hash, entryB.Hash)
	}
	if entryA.RowCount != entryB.RowCount {
		t.Errorf("row_count mismatch: A=%d, B=%d", entryA.RowCount, entryB.RowCount)
	}
	if entryA.ListID != listID || entryB.ListID != listID {
		t.Errorf("list_id mismatch: A=%s, B=%s, want %s", entryA.ListID, entryB.ListID, listID)
	}
}

// TestDigest_ExcludesNonMemberLists: Bob is NOT a member of Alice's list;
// Bob's digest response contains no entry for Alice's list.
func TestDigest_ExcludesNonMemberLists(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, _ := testutil.CreateAccount(t, app, "Alice")
	_, tokB := testutil.CreateAccount(t, app, "Bob")
	_ = testutil.CreateListFor(t, app, acctA, "Test") // Alice's list

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tokB))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}

	var entries []digestEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(entries) != 0 {
		t.Errorf("entries count = %d, want 0 (Bob has no lists)", len(entries))
	}
}

// TestDigest_CarriesOwnMembership ([D-28]): each entry carries the caller's own
// membership row for its list — the entries ARE the membership set the client
// purges against — and never a co-member's (who is on the list is the §7.4
// roster's business). The entry also carries the list's one name ([D-08]),
// the same for every member.
func TestDigest_CarriesOwnMembership(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, tokA := testutil.CreateAccount(t, app, "Alice")
	acctB, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test") // named "Test"
	addMembership(t, app, acctB, listID)

	// Alice has a second list of her own, so a name cannot come out right by
	// accident (one name for every entry, or the first list's for all).
	other := testutil.CreateListFor(t, app, acctA, "Test")
	otherRec, err := app.FindRecordById("lists", other)
	if err != nil {
		t.Fatalf("find list: %v", err)
	}
	otherRec.Set("name", "Baumarkt")
	if err := app.SaveNoValidate(otherRec); err != nil {
		t.Fatalf("rename list: %v", err)
	}

	digestOf := func(tok string) []digestEntry {
		t.Helper()
		rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", rec.Code, body)
		}
		var entries []digestEntry
		if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return entries
	}

	entries := digestOf(tokB)
	if len(entries) != 1 {
		t.Fatalf("entries count = %d, want 1", len(entries))
	}
	m := entries[0].Membership
	if m.Account != acctB || m.List != listID {
		t.Errorf("membership = %+v, want Bob's own row for %s", m, listID)
	}
	if m.ID == "" || m.Created == "" || m.Updated == "" {
		t.Errorf("membership missing id/created/updated: %+v", m)
	}
	if entries[0].Name != "Test" {
		t.Errorf("Bob's entry name = %q, want the list's %q", entries[0].Name, "Test")
	}

	own, err := app.FindFirstRecordByFilter("memberships", "account = {:a}", map[string]any{"a": acctB})
	if err != nil {
		t.Fatalf("find Bob's membership: %v", err)
	}
	if m.ID != own.Id {
		t.Errorf("membership id = %s, want %s", m.ID, own.Id)
	}

	// Alice sees the same name for the shared list, and her other list's own.
	wantName := map[string]string{listID: "Test", other: "Baumarkt"}
	aEntries := digestOf(tokA)
	if len(aEntries) != 2 {
		t.Fatalf("Alice's entries = %d, want 2", len(aEntries))
	}
	for _, e := range aEntries {
		if e.Membership.Account != acctA {
			t.Errorf("Alice's digest carries another account's membership: %+v", e.Membership)
		}
		if e.Name != wantName[e.ListID] {
			t.Errorf("Alice's entry for %s: name = %q, want %q", e.ListID, e.Name, wantName[e.ListID])
		}
	}
}

// TestDigest_StableWhenUnchanged: two GETs with no writes in between → identical hash.
func TestDigest_StableWhenUnchanged(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	_ = testutil.CreateListFor(t, app, acctID, "Test")

	// First GET
	rec1, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec1.Code != http.StatusOK {
		t.Fatalf("first status = %d: %s", rec1.Code, rec1.Body.String())
	}
	var entries1 []digestEntry
	json.Unmarshal(rec1.Body.Bytes(), &entries1)

	// Second GET (no writes in between)
	rec2, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec2.Code != http.StatusOK {
		t.Fatalf("second status = %d: %s", rec2.Code, rec2.Body.String())
	}
	var entries2 []digestEntry
	json.Unmarshal(rec2.Body.Bytes(), &entries2)

	if len(entries1) != 1 || len(entries2) != 1 {
		t.Fatalf("entries count: first=%d, second=%d, want 1 each", len(entries1), len(entries2))
	}

	if entries1[0].Hash != entries2[0].Hash {
		t.Errorf("hash changed: first=%s, second=%s", entries1[0].Hash, entries2[0].Hash)
	}
}

// TestDigest_ChangesAfterPush: GET digest; then push a new item; GET digest again →
// hash AND max_updated changed, row_count incremented.
func TestDigest_ChangesAfterPush(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// First GET
	rec1, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec1.Code != http.StatusOK {
		t.Fatalf("first status = %d: %s", rec1.Code, rec1.Body.String())
	}
	var entries1 []digestEntry
	json.Unmarshal(rec1.Body.Bytes(), &entries1)
	if len(entries1) != 1 {
		t.Fatalf("first entries count = %d, want 1", len(entries1))
	}
	firstHash := entries1[0].Hash
	firstMaxUpdated := entries1[0].MaxUpdated
	firstRowCount := entries1[0].RowCount

	// Push a new item
	itemID := randid.ID()
	ops := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	_ = push(t, mux, tok, ops)

	// Second GET
	rec2, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec2.Code != http.StatusOK {
		t.Fatalf("second status = %d: %s", rec2.Code, rec2.Body.String())
	}
	var entries2 []digestEntry
	json.Unmarshal(rec2.Body.Bytes(), &entries2)
	if len(entries2) != 1 {
		t.Fatalf("second entries count = %d, want 1", len(entries2))
	}
	secondHash := entries2[0].Hash
	secondMaxUpdated := entries2[0].MaxUpdated
	secondRowCount := entries2[0].RowCount

	if firstHash == secondHash {
		t.Errorf("hash did not change after push: %s", firstHash)
	}
	if firstMaxUpdated == secondMaxUpdated {
		t.Errorf("max_updated did not change after push: %s", firstMaxUpdated)
	}
	if secondRowCount != firstRowCount+1 {
		t.Errorf("row_count: first=%d, second=%d, want second = first+1", firstRowCount, secondRowCount)
	}
}

// TestDigest_IncludesTombstones: push an item, then tombstone it (update deleted:true);
// the digest row_count STILL counts it (tombstones stay until GC) and the hash reflects the tombstone's bumped `updated`.
func TestDigest_IncludesTombstones(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// Create an item
	itemID := randid.ID()
	opsCreate := []pushOp{{
		OpID:       "create",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "create",
		Changed:    map[string]any{"name": "Milk"},
	}}
	_ = push(t, mux, tok, opsCreate)

	// Get digest before tombstone
	rec1, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec1.Code != http.StatusOK {
		t.Fatalf("first status = %d: %s", rec1.Code, rec1.Body.String())
	}
	var entries1 []digestEntry
	json.Unmarshal(rec1.Body.Bytes(), &entries1)
	if len(entries1) != 1 {
		t.Fatalf("first entries count = %d, want 1", len(entries1))
	}
	beforeRowCount := entries1[0].RowCount
	beforeHash := entries1[0].Hash

	// Tombstone the item (sleep first to guarantee updated bumps to a new
	// millisecond — PB's autodate is ms-precision, so two sub-ms writes collide).
	time.Sleep(5 * time.Millisecond)
	opsDelete := []pushOp{{
		OpID:       "delete",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	_ = push(t, mux, tok, opsDelete)

	// Get digest after tombstone
	rec2, _ := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(tok))
	if rec2.Code != http.StatusOK {
		t.Fatalf("second status = %d: %s", rec2.Code, rec2.Body.String())
	}
	var entries2 []digestEntry
	json.Unmarshal(rec2.Body.Bytes(), &entries2)
	if len(entries2) != 1 {
		t.Fatalf("second entries count = %d, want 1", len(entries2))
	}
	afterRowCount := entries2[0].RowCount
	afterHash := entries2[0].Hash

	// Row count should NOT decrease (tombstones stay)
	if afterRowCount != beforeRowCount {
		t.Errorf("row_count changed: before=%d, after=%d, want same", beforeRowCount, afterRowCount)
	}

	// Hash should change (updated field is bumped on tombstone)
	if beforeHash == afterHash {
		t.Errorf("hash did not change after tombstone: %s", beforeHash)
	}

	// Verify the record is tombstoned
	itemRec, _ := app.FindRecordById(collectionItems, itemID)
	if itemRec == nil {
		t.Fatal("item should still exist (tombstoned)")
	}
	if itemRec.GetString("deleted_at") == "" {
		t.Error("item should be tombstoned (deleted_at non-empty)")
	}
}

// TestDigest_SharedVectors pins the digest algorithm against seed/digest-vectors.json,
// the fixture the Vitest suite reads too (§8.5 [D-40]; same technique as the [D-44]
// normalization vectors). If the Go and TypeScript digests ever disagree, every list
// looks permanently diverged and the client pulls a full snapshot every cycle — a
// silent, expensive failure that no single-language test can catch.
func TestDigest_SharedVectors(t *testing.T) {
	data, err := os.ReadFile("../../seed/digest-vectors.json")
	if err != nil {
		t.Fatalf("read digest-vectors.json: %v", err)
	}
	var vectors []struct {
		Note string `json:"note"`
		Rows []struct {
			ID      string `json:"id"`
			Updated string `json:"updated"`
		} `json:"rows"`
		RowCount   int    `json:"row_count"`
		MaxUpdated string `json:"max_updated"`
		Hash       string `json:"hash"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("unmarshal digest-vectors.json: %v", err)
	}
	if len(vectors) == 0 {
		t.Fatal("digest-vectors.json is empty")
	}

	for _, v := range vectors {
		keys := make([]rowKey, len(v.Rows))
		for i, r := range v.Rows {
			keys[i] = rowKey{Id: r.ID, Updated: r.Updated}
		}
		hash, rowCount, maxUpdated := digestOf(keys)
		if hash != v.Hash {
			t.Errorf("%s: hash = %s, want %s", v.Note, hash, v.Hash)
		}
		if rowCount != v.RowCount {
			t.Errorf("%s: row_count = %d, want %d", v.Note, rowCount, v.RowCount)
		}
		if maxUpdated != v.MaxUpdated {
			t.Errorf("%s: max_updated = %q, want %q", v.Note, maxUpdated, v.MaxUpdated)
		}
	}
}
