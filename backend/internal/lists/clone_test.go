package lists

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// addTestCategory saves a list_categories row directly and returns its id.
// tombstoned=true sets deleted_at so the row is a soft-deleted tombstone.
func addTestCategory(t *testing.T, app core.App, listID string, sortOrder int, tombstoned bool) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("list_categories")
	if err != nil {
		t.Fatalf("find list_categories collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("list", listID)
	rec.Set("slug", "cat-"+randid.ID())
	rec.Set("icon", "icon")
	rec.Set("color", "color")
	rec.Set("sort_order", sortOrder)
	if tombstoned {
		rec.Set("deleted_at", types.NowDateTime())
	}
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save list_category: %v", err)
	}
	return rec.Id
}

// addTestItem saves an items row directly (name/quantity defaults) and returns
// its id. mutators customize the row, e.g. category_key, checked state or a
// deleted_at tombstone.
func addTestItem(t *testing.T, app core.App, listID string, mutators ...func(*core.Record)) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("list", listID)
	rec.Set("name", "Item")
	rec.Set("quantity", "1")
	for _, m := range mutators {
		m(rec)
	}
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save item: %v", err)
	}
	return rec.Id
}

// TestCloneList (§7.5 [D-72]): POST /api/lists/{listId}/clone copies the source
// list's living categories and items into a fresh list with the cloner as its
// sole member, resetting all shopping state.
func TestCloneList(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

		srcID := testutil.CreateList(t, app, "Familie")
		testutil.AddMembership(t, app, aliceID, srcID)

		// 2 living + 1 tombstoned category.
		catA := addTestCategory(t, app, srcID, 0, false)
		catB := addTestCategory(t, app, srcID, 1, false)
		catTomb := addTestCategory(t, app, srcID, 2, true)
		// [D-266] The photo a's barcode has now: the copy takes this, not the
		// source row's stored path.
		photo := testutil.SeedProductPhoto(t, app, "4000417025005")

		// (a) living category, (b) tombstoned category, (c) no category,
		// (d) checked with timestamps, (e) tombstoned item, (f) unchecked but
		// with a last_bought_at.
		idA := addTestItem(t, app, srcID, func(r *core.Record) {
			r.Set("name", "a")
			r.Set("category_key", catA)
			r.Set("note", "die reifen")
			r.Set("barcode", "4000417025005")
			r.Set("name_de", "a-de")
			r.Set("name_en", "a-en")
		})
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "b"); r.Set("category_key", catTomb) })
		// [D-266] No barcode, no photo, whatever the row holds.
		idC := addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "c") })
		// A row from before [D-266] holds what its client sent; the save hook
		// stamps every later one, so the raw UPDATE.
		for id, url := range map[string]string{
			idA: "/api/barcode/photo/0123456789abcdef0123456789abcdef",
			idC: "https://tracker.example/pixel.gif",
		} {
			if _, err := app.DB().NewQuery("UPDATE items SET image_url = {:url} WHERE id = {:id}").
				Bind(dbx.Params{"url": url, "id": id}).Execute(); err != nil {
				t.Fatal(err)
			}
		}
		checkedAtD, _ := types.ParseDateTime("2026-01-01 10:00:00.000Z")
		lastBoughtD, _ := types.ParseDateTime("2026-01-02 10:00:00.000Z")
		prevBoughtD, _ := types.ParseDateTime("2025-12-01 10:00:00.000Z")
		addTestItem(t, app, srcID, func(r *core.Record) {
			r.Set("name", "d")
			r.Set("checked", true)
			r.Set("checked_at", checkedAtD)
			r.Set("last_bought_at", lastBoughtD)
			r.Set("prev_bought_at", prevBoughtD)
		})
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "e"); r.Set("deleted_at", types.NowDateTime()) })
		lastBoughtF, _ := types.ParseDateTime("2026-01-03 10:00:00.000Z")
		addTestItem(t, app, srcID, func(r *core.Record) {
			r.Set("name", "f")
			r.Set("last_bought_at", lastBoughtF)
		})

		srcCatCount, _ := app.CountRecords("list_categories", dbx.HashExp{"list": srcID})
		srcItemCount, _ := app.CountRecords("items", dbx.HashExp{"list": srcID})

		body := `{"name":"Familie (Kopie)"}`
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", body, testutil.AuthHeader(aliceTok))
		newID := listIDOf(t, respBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("clone status = %d, want 200: %s", rec.Code, respBody)
		}
		if !strings.Contains(respBody, newID) {
			t.Errorf("response body missing new list id %q: %s", newID, respBody)
		}

		// The copy carries the name the request gave it ([D-08]).
		assertListName(t, app, newID, "Familie (Kopie)")

		// Exactly one membership: Alice.
		memberships, err := app.FindAllRecords("memberships", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find memberships: %v", err)
		}
		if len(memberships) != 1 {
			t.Fatalf("memberships count = %d, want 1", len(memberships))
		}
		if got := memberships[0].GetString("account"); got != aliceID {
			t.Errorf("membership account = %q, want %q", got, aliceID)
		}

		// Exactly 2 categories: the tombstoned one is never copied.
		newCats, err := app.FindAllRecords("list_categories", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new list_categories: %v", err)
		}
		if len(newCats) != 2 {
			t.Fatalf("new list_categories count = %d, want 2", len(newCats))
		}

		// Exactly 5 items: the tombstoned one is never copied.
		newItems, err := app.FindAllRecords("items", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new items: %v", err)
		}
		if len(newItems) != 5 {
			t.Fatalf("new items count = %d, want 5", len(newItems))
		}

		// Nothing is ever tombstoned in a clone.
		for _, it := range newItems {
			if !it.GetDateTime("deleted_at").IsZero() {
				t.Errorf("item %s deleted_at not zero", it.Id)
			}
		}

		newCatIDs := make(map[string]bool, len(newCats))
		for _, c := range newCats {
			newCatIDs[c.Id] = true
		}
		srcCatIDs := map[string]bool{catA: true, catB: true, catTomb: true}

		byName := make(map[string]*core.Record, len(newItems))
		for _, it := range newItems {
			byName[it.GetString("name")] = it
		}

		// [D-72] shopping state is copied verbatim: (d) was checked with both
		// stamps, so its clone is checked with identical stamps; (f) was
		// unchecked but had a last_bought_at, which survives independently.
		itemD := byName["d"]
		if itemD == nil {
			t.Fatalf("cloned item %q not found", "d")
		}
		if !itemD.GetBool("checked") {
			t.Errorf("item d checked = false, want true")
		}
		if got := itemD.GetDateTime("checked_at"); !got.Time().Equal(checkedAtD.Time()) {
			t.Errorf("item d checked_at = %v, want %v", got, checkedAtD)
		}
		if got := itemD.GetDateTime("last_bought_at"); !got.Time().Equal(lastBoughtD.Time()) {
			t.Errorf("item d last_bought_at = %v, want %v", got, lastBoughtD)
		}
		// [D-303] The date the tick replaced, so taking the tick back on the
		// copy restores it rather than forgetting the purchase.
		if got := itemD.GetDateTime("prev_bought_at"); !got.Time().Equal(prevBoughtD.Time()) {
			t.Errorf("item d prev_bought_at = %v, want %v", got, prevBoughtD)
		}
		itemF := byName["f"]
		if itemF == nil {
			t.Fatalf("cloned item %q not found", "f")
		}
		if itemF.GetBool("checked") {
			t.Errorf("item f checked = true, want false")
		}
		if !itemF.GetDateTime("checked_at").IsZero() {
			t.Errorf("item f checked_at not zero")
		}
		if got := itemF.GetDateTime("last_bought_at"); !got.Time().Equal(lastBoughtF.Time()) {
			t.Errorf("item f last_bought_at = %v, want %v", got, lastBoughtF)
		}

		// The rest were unchecked with no stamps.
		for _, it := range newItems {
			if it.GetString("name") == "d" || it.GetString("name") == "f" {
				continue
			}
			if it.GetBool("checked") {
				t.Errorf("item %s checked = true, want false", it.Id)
			}
			if !it.GetDateTime("checked_at").IsZero() {
				t.Errorf("item %s checked_at not zero", it.Id)
			}
			if !it.GetDateTime("last_bought_at").IsZero() {
				t.Errorf("item %s last_bought_at not zero", it.Id)
			}
		}

		// (a) remapped to a fresh category id, never a source id.
		itemA := byName["a"]
		if itemA == nil {
			t.Fatalf("cloned item %q not found", "a")
		}
		if ck := itemA.GetString("category_key"); !newCatIDs[ck] {
			t.Errorf("item a category_key = %q, want one of the new category ids", ck)
		} else if srcCatIDs[ck] {
			t.Errorf("item a category_key = %q, must not be a source category id", ck)
		}

		// (b) source category was tombstoned -> null (Others fallback).
		if ck := byName["b"].GetString("category_key"); ck != "" {
			t.Errorf("item b category_key = %q, want empty", ck)
		}
		// (c) had no category -> stays null.
		if ck := byName["c"].GetString("category_key"); ck != "" {
			t.Errorf("item c category_key = %q, want empty", ck)
		}

		// (a) carries its localized names [D-21] and note/barcode verbatim, and
		// the photo its barcode has ([D-266]).
		if got := itemA.GetString("name_de") + "|" + itemA.GetString("name_en"); got != "a-de|a-en" {
			t.Errorf("item a localized names = %q, want %q", got, "a-de|a-en")
		}
		if got := byName["c"].GetString("name_de") + byName["c"].GetString("name_en"); got != "" {
			t.Errorf("item c localized names = %q, want empty", got)
		}
		if got := itemA.GetString("note"); got != "die reifen" {
			t.Errorf("item a note = %q, want %q", got, "die reifen")
		}
		if got := itemA.GetString("barcode"); got != "4000417025005" {
			t.Errorf("item a barcode = %q, want %q", got, "4000417025005")
		}
		if got := itemA.GetString("image_url"); got != photo {
			t.Errorf("item a image_url = %q, want its barcode's photo %q", got, photo)
		}
		if got := byName["c"].GetString("image_url"); got != "" {
			t.Errorf("item c image_url = %q, want it dropped", got)
		}
		// (c) had none -> stays empty.
		if got := byName["c"].GetString("note"); got != "" {
			t.Errorf("item c note = %q, want empty", got)
		}
		if got := byName["c"].GetString("barcode"); got != "" {
			t.Errorf("item c barcode = %q, want empty", got)
		}
		if got := byName["c"].GetString("image_url"); got != "" {
			t.Errorf("item c image_url = %q, want empty", got)
		}

		// Source list untouched.
		if n, _ := app.CountRecords("list_categories", dbx.HashExp{"list": srcID}); n != srcCatCount {
			t.Errorf("source list_categories count = %d, want %d", n, srcCatCount)
		}
		if n, _ := app.CountRecords("items", dbx.HashExp{"list": srcID}); n != srcItemCount {
			t.Errorf("source items count = %d, want %d", n, srcItemCount)
		}
	})

	t.Run("custom name", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

		srcID := testutil.CreateList(t, app, "Familie")
		testutil.AddMembership(t, app, aliceID, srcID)

		body := `{"name":"Sonder"}`
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", body, testutil.AuthHeader(aliceTok))
		newID := listIDOf(t, respBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("clone status = %d, want 200: %s", rec.Code, respBody)
		}

		assertListName(t, app, newID, "Sonder")
		assertListName(t, app, srcID, "Familie") // the source keeps its name
		if n, _ := app.CountRecords("memberships", dbx.HashExp{"list": newID, "account": aliceID}); n != 1 {
			t.Fatalf("cloner's memberships on the copy = %d, want 1", n)
		}
	})

	// The name is required, as at create and rename: the server holds no UI
	// text, so there is no default for it to fall back to. A blank one is no
	// name. Either way nothing is created.
	for _, tc := range []struct{ name, body string }{
		{"missing name is refused", `{}`},
		{"blank name is refused", `{"name":"   "}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app, mux := setupListsApp(t)
			aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")
			srcID := testutil.CreateList(t, app, "Familie")
			testutil.AddMembership(t, app, aliceID, srcID)
			listsBefore, _ := app.CountRecords("lists")

			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", tc.body, testutil.AuthHeader(aliceTok))
			if rec.Code != http.StatusBadRequest || !strings.Contains(respBody, "Name is required") {
				t.Fatalf("clone status = %d, want 400 name is required: %s", rec.Code, respBody)
			}
			if n, _ := app.CountRecords("lists"); n != listsBefore {
				t.Errorf("lists count = %d, want %d — a refused clone created a list", n, listsBefore)
			}
		})
	}

	t.Run("over-cap name is refused", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")
		srcID := testutil.CreateList(t, app, "Familie")
		testutil.AddMembership(t, app, aliceID, srcID)
		max, ok := fieldcontract.MaxBytes("lists", "name")
		if !ok {
			t.Fatal("contract has no lists.name cap")
		}

		body, _ := json.Marshal(map[string]string{"name": strings.Repeat("x", max+1)})
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", string(body), testutil.AuthHeader(aliceTok))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("over-cap clone name status = %d, want 400: %s", rec.Code, respBody)
		}
		if n, _ := app.CountRecords("lists"); n != 1 {
			t.Errorf("lists = %d after a refused clone, want 1 (the source)", n)
		}
	})

	t.Run("non-member 403 + no rows", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, _ := testutil.CreateAccount(t, app, "Alice")
		_, bobTok := testutil.CreateAccount(t, app, "Bob")

		srcID := testutil.CreateList(t, app, "")
		testutil.AddMembership(t, app, aliceID, srcID)
		addTestCategory(t, app, srcID, 0, false)
		addTestItem(t, app, srcID)

		// A refused clone creates NOTHING: the only list in the database is
		// still the source. (The caller supplies no id [D-08], so this is the
		// whole property.)
		listsBefore, _ := app.CountRecords("lists")
		membershipsBefore, _ := app.CountRecords("memberships")

		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", `{}`, testutil.AuthHeader(bobTok))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("non-member clone status = %d, want 403: %s", rec.Code, respBody)
		}

		if n, _ := app.CountRecords("lists"); n != listsBefore {
			t.Errorf("lists count = %d, want %d — a refused clone created a list", n, listsBefore)
		}
		if n, _ := app.CountRecords("memberships"); n != membershipsBefore {
			t.Errorf("memberships count = %d, want %d — a refused clone created a membership", n, membershipsBefore)
		}
	})

	t.Run("modified_by", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

		srcID := testutil.CreateList(t, app, "")
		testutil.AddMembership(t, app, aliceID, srcID)
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "x") })
		addTestItem(t, app, srcID, func(r *core.Record) { r.Set("name", "y") })

		body := `{"name":"Kopie"}`
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+srcID+"/clone", body, testutil.AuthHeader(aliceTok))
		newID := listIDOf(t, respBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("clone status = %d, want 200: %s", rec.Code, respBody)
		}

		items, err := app.FindAllRecords("items", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new items: %v", err)
		}
		if len(items) != 2 {
			t.Fatalf("new items count = %d, want 2", len(items))
		}
		for _, it := range items {
			if got := it.GetString("modified_by"); got != aliceID {
				t.Errorf("item %s modified_by = %q, want %q", it.Id, got, aliceID)
			}
		}
	})
}
