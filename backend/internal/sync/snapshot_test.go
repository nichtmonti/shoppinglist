package sync

import (
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// snapshotRows decodes a snapshot response into plain maps — the shape the
// client's normalizers read.
type snapshotRows struct {
	Items      []map[string]any `json:"items"`
	Categories []map[string]any `json:"categories"`
}

func getSnapshot(t *testing.T, mux http.Handler, token, path string) (int, snapshotRows) {
	t.Helper()
	var headers map[string]string
	if token != "" {
		headers = testutil.AuthHeader(token)
	}
	rec, body := testutil.DoReq(mux, http.MethodGet, path, "", headers)
	var rows snapshotRows
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal([]byte(body), &rows); err != nil {
			t.Fatalf("unmarshal: %v (%s)", err, body)
		}
	}
	return rec.Code, rows
}

// [D-173] The snapshot is the repair authority — its sweep drops local rows the
// server did not return — so "not allowed" must never look like "no rows".
func TestSnapshot_Unauthenticated(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, _ := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	code, _ := getSnapshot(t, mux, "", "/api/sync/snapshot/"+listID)
	if code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", code)
	}
}

// A non-member gets the same 403 for someone else's list and for a list that
// does not exist: the route must not leak list existence ([D-74]).
func TestSnapshot_NonMemberAndMissingListAreIndistinguishable(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctA, _ := testutil.CreateAccount(t, app, "Alice")
	_, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctA, "Test")

	for _, path := range []string{"/api/sync/snapshot/" + listID, "/api/sync/snapshot/nosuchlist12345"} {
		code, _ := getSnapshot(t, mux, tokB, path)
		if code != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403", path, code)
		}
	}
}

// A member gets every row of the list — tombstones included, so deletes
// propagate — and nothing from another list.
func TestSnapshot_FullListIncludingTombstones(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	otherList := testutil.CreateListFor(t, app, acctID, "Test")
	catID := seedOtherCategory(t, app, listID)
	_ = seedOtherCategory(t, app, otherList)

	keep, gone := randid.ID(), randid.ID()
	push(t, mux, tok, []pushOp{
		{OpID: "a", Collection: collectionItems, RecordID: keep, ListID: listID, Type: "create", Changed: map[string]any{"name": "Milk"}},
		{OpID: "b", Collection: collectionItems, RecordID: gone, ListID: listID, Type: "create", Changed: map[string]any{"name": "Bread"}},
		{OpID: "c", Collection: collectionItems, RecordID: randid.ID(), ListID: otherList, Type: "create", Changed: map[string]any{"name": "Eggs"}},
	})
	push(t, mux, tok, []pushOp{
		{OpID: "d", Collection: collectionItems, RecordID: gone, ListID: listID, Type: "update", Changed: map[string]any{"deleted": true}},
	})

	code, rows := getSnapshot(t, mux, tok, "/api/sync/snapshot/"+listID)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	ids := map[string]map[string]any{}
	for _, it := range rows.Items {
		ids[it["id"].(string)] = it
		if it["list"] != listID {
			t.Errorf("item %v belongs to list %v", it["id"], it["list"])
		}
	}
	if len(ids) != 2 || ids[keep] == nil || ids[gone] == nil {
		t.Fatalf("items = %v, want exactly %s and %s", rows.Items, keep, gone)
	}
	if ids[gone]["deleted_at"] == "" {
		t.Errorf("tombstone missing its deleted_at: %v", ids[gone])
	}
	if len(rows.Categories) != 1 || rows.Categories[0]["id"] != catID {
		t.Errorf("categories = %v, want only %s", rows.Categories, catID)
	}
}

// An empty list is a 200 with empty arrays — never null, which the client
// would read as malformed.
func TestSnapshot_EmptyListIsEmptyArrays(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/snapshot/"+listID, "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}
	if strings.TrimSpace(body) != `{"items":[],"categories":[]}` {
		t.Errorf("body = %s, want empty arrays", body)
	}
}

// `since` returns only rows changed after it — the [D-40] delta.
func TestSnapshot_SinceReturnsOnlyNewerRows(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	old := randid.ID()
	push(t, mux, tok, []pushOp{{OpID: "a", Collection: collectionItems, RecordID: old, ListID: listID, Type: "create", Changed: map[string]any{"name": "Milk"}}})
	_, before := getSnapshot(t, mux, tok, "/api/sync/snapshot/"+listID)
	since := before.Items[0]["updated"].(string)

	// PB's autodate is ms-precision; make sure the next write lands after `since`.
	time.Sleep(5 * time.Millisecond)
	fresh := randid.ID()
	push(t, mux, tok, []pushOp{{OpID: "b", Collection: collectionItems, RecordID: fresh, ListID: listID, Type: "create", Changed: map[string]any{"name": "Bread"}}})

	code, rows := getSnapshot(t, mux, tok, "/api/sync/snapshot/"+listID+"?since="+url.QueryEscape(since))
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if len(rows.Items) != 1 || rows.Items[0]["id"] != fresh {
		t.Errorf("items = %v, want only %s", rows.Items, fresh)
	}
}

// A client that accepts gzip gets the snapshot compressed, and the same rows.
func TestSnapshot_CompressedWhenAsked(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	ops := make([]pushOp, 0, 40)
	for i := range 40 {
		ops = append(ops, pushOp{OpID: randid.ID(), Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create", Changed: map[string]any{"name": "Milk " + randid.ID()[:4+i%4]}})
	}
	push(t, mux, tok, ops)

	headers := testutil.AuthHeader(tok)
	headers["Accept-Encoding"] = "gzip"
	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/snapshot/"+listID, "", headers)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("status = %d, Content-Encoding = %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var rows snapshotRows
	if err := json.NewDecoder(zr).Decode(&rows); err != nil {
		t.Fatal(err)
	}
	if len(rows.Items) != 40 {
		t.Errorf("items = %d, want 40", len(rows.Items))
	}
}

// `ids` answers the list's id set, tombstones included and nothing from another
// list, behind the same gate as the snapshot, and compressed when asked ([D-40]).
func TestSnapshot_IDsAreTheListsIDSet(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	_, tokB := testutil.CreateAccount(t, app, "Bob")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	otherList := testutil.CreateListFor(t, app, acctID, "Test")
	catID := seedOtherCategory(t, app, listID)
	_ = seedOtherCategory(t, app, otherList)

	keep, gone := randid.ID(), randid.ID()
	ops := []pushOp{
		{OpID: "a", Collection: collectionItems, RecordID: keep, ListID: listID, Type: "create", Changed: map[string]any{"name": "Milk"}},
		{OpID: "b", Collection: collectionItems, RecordID: gone, ListID: listID, Type: "create", Changed: map[string]any{"name": "Bread"}},
		{OpID: "c", Collection: collectionItems, RecordID: randid.ID(), ListID: otherList, Type: "create", Changed: map[string]any{"name": "Eggs"}},
	}
	for i := range 60 { // past the gzip threshold
		ops = append(ops, pushOp{OpID: randid.ID(), Collection: collectionItems, RecordID: randid.ID(), ListID: otherList, Type: "create", Changed: map[string]any{"name": "Milk " + randid.ID()[:4+i%4]}})
	}
	push(t, mux, tok, ops)
	push(t, mux, tok, []pushOp{
		{OpID: "d", Collection: collectionItems, RecordID: gone, ListID: listID, Type: "update", Changed: map[string]any{"deleted": true}},
	})

	path := "/api/sync/snapshot/" + listID + "?ids"
	if code, _ := getSnapshot(t, mux, "", path); code != http.StatusUnauthorized {
		t.Errorf("anonymous: status = %d, want 401", code)
	}
	if code, _ := getSnapshot(t, mux, tokB, path); code != http.StatusForbidden {
		t.Errorf("non-member: status = %d, want 403", code)
	}

	rec, body := testutil.DoReq(mux, http.MethodGet, path, "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}
	var got snapshotIDs
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, body)
	}
	sort.Strings(got.Items)
	want := []string{keep, gone}
	sort.Strings(want)
	if !slices.Equal(got.Items, want) || !slices.Equal(got.Categories, []string{catID}) {
		t.Errorf("ids = %+v, want items %v and categories [%s]", got, want, catID)
	}

	other := "/api/sync/snapshot/" + otherList + "?ids"
	headers := testutil.AuthHeader(tok)
	headers["Accept-Encoding"] = "gzip"
	rec, body = testutil.DoReq(mux, http.MethodGet, other, "", headers)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("status = %d, Content-Encoding = %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(zr).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 61 {
		t.Errorf("items = %d, want 61", len(got.Items))
	}
}

// An empty list's id set is empty arrays, never null.
func TestSnapshot_IDsOfAnEmptyListAreEmptyArrays(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/snapshot/"+listID+"?ids", "", testutil.AuthHeader(tok))
	if rec.Code != http.StatusOK || strings.TrimSpace(body) != `{"items":[],"categories":[]}` {
		t.Errorf("status = %d, body = %s, want empty arrays", rec.Code, body)
	}
}
