package lists

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/testutil"
)

// validBackup returns a backup document that passes every import validation:
// 2 categories (c0 with null slug+name, c1 with slug+name) and 3 items
// referencing c0, null and c1.
//
// c1's slug is a REAL `category_templates` slug, because that is the only kind
// a genuine export can contain — §7.5 list-create copies the template roster,
// and a member-added row has a null slug. [D-08] made the import route enforce
// that, so an invented slug here would (correctly) be refused.
func validBackup() map[string]any {
	return map[string]any{
		"format":       "einkaufsliste/list-backup",
		"version":      fieldcontract.BackupVersion(),
		"exported_at":  "2026-01-01T00:00:00Z",
		"display_name": "BackupName",
		"categories": []any{
			map[string]any{"key": "c0", "slug": nil, "name": nil, "icon": "icon0", "color": "color0", "sort_order": 0},
			map[string]any{"key": "c1", "slug": "produce", "name": "Name1", "icon": "icon1", "color": "color1", "sort_order": 1},
		},
		"items": []any{
			map[string]any{"name": "a", "quantity": "1", "note": nil, "category_key": "c0", "barcode": nil, "image_url": nil},
			map[string]any{"name": "b", "quantity": "2", "note": nil, "category_key": nil, "barcode": nil, "image_url": nil},
			map[string]any{"name": "c", "quantity": "3", "note": nil, "category_key": "c1", "barcode": nil, "image_url": nil},
		},
	}
}

// importBody marshals an import request body. name "" omits the body's
// `name` field entirely (exercising the fallback chain). The backup document
// keeps its own `display_name` key — that is the file format, not the route.
func importBody(t *testing.T, name string, backup map[string]any) string {
	t.Helper()
	body := map[string]any{"backup": backup}
	if name != "" {
		body["name"] = name
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal import body: %v", err)
	}
	return string(b)
}

// TestImportList (§7.5 [D-72]): POST /api/lists/import restores a backup
// document into a fresh list owned by the caller, with no membership guard.
// The document carries the shopping state and it is restored verbatim
// verbatim [D-72].
func TestImportList(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		backup["display_name"] = "Urlaub"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(aliceTok))
		newID := listIDOf(t, respBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
		}
		if !strings.Contains(respBody, newID) {
			t.Errorf("response body missing list id %q: %s", newID, respBody)
		}

		// The list is named from the backup's display_name ([D-08]).
		assertListName(t, app, newID, "Urlaub")

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

		// Exactly 2 categories; c0 has null slug AND name.
		newCats, err := app.FindAllRecords("list_categories", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new list_categories: %v", err)
		}
		if len(newCats) != 2 {
			t.Fatalf("new list_categories count = %d, want 2", len(newCats))
		}
		var cat0, cat1 *core.Record
		for _, c := range newCats {
			if c.GetString("slug") == "produce" {
				cat1 = c
			} else {
				cat0 = c
			}
		}
		if cat0 == nil || cat1 == nil {
			t.Fatalf("expected categories c0 (null slug) and c1 (slug produce), got %d rows", len(newCats))
		}
		if got := cat0.GetString("slug"); got != "" {
			t.Errorf("category c0 slug = %q, want empty (null)", got)
		}
		if got := cat0.GetString("name"); got != "" {
			t.Errorf("category c0 name = %q, want empty (null)", got)
		}
		if got := cat1.GetString("name"); got != "Name1" {
			t.Errorf("category c1 name = %q, want %q", got, "Name1")
		}

		// Exactly 3 items with the file-local keys remapped to fresh ids.
		newItems, err := app.FindAllRecords("items", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new items: %v", err)
		}
		if len(newItems) != 3 {
			t.Fatalf("new items count = %d, want 3", len(newItems))
		}
		byName := make(map[string]*core.Record, len(newItems))
		for _, it := range newItems {
			byName[it.GetString("name")] = it
		}
		itemA := byName["a"]
		if itemA == nil {
			t.Fatalf("imported item %q not found", "a")
		}
		if ck := itemA.GetString("category_key"); ck != cat0.Id {
			t.Errorf("item a category_key = %q, want new id of c0 (%q)", ck, cat0.Id)
		}
		itemB := byName["b"]
		if itemB == nil {
			t.Fatalf("imported item %q not found", "b")
		}
		if ck := itemB.GetString("category_key"); ck != "" {
			t.Errorf("item b category_key = %q, want empty", ck)
		}
		itemC := byName["c"]
		if itemC == nil {
			t.Fatalf("imported item %q not found", "c")
		}
		if ck := itemC.GetString("category_key"); ck != cat1.Id {
			t.Errorf("item c category_key = %q, want new id of c1 (%q)", ck, cat1.Id)
		}

		// Import is a fresh shopping run: no shopping state survives, and
		// modified_by is the importer.
		for _, it := range newItems {
			if it.GetBool("checked") {
				t.Errorf("item %s checked = true, want false", it.Id)
			}
			if !it.GetDateTime("checked_at").IsZero() {
				t.Errorf("item %s checked_at not zero", it.Id)
			}
			if !it.GetDateTime("last_bought_at").IsZero() {
				t.Errorf("item %s last_bought_at not zero", it.Id)
			}
			if !it.GetDateTime("deleted_at").IsZero() {
				t.Errorf("item %s deleted_at not zero", it.Id)
			}
			if got := it.GetString("modified_by"); got != aliceID {
				t.Errorf("item %s modified_by = %q, want %q", it.Id, got, aliceID)
			}
		}
	})

	t.Run("state restored verbatim", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		items := backup["items"].([]any)
		// The push route stamps checked_at = last_bought_at with ONE now()
		// ([D-26]) and import now enforces the pair — a real export always
		// carries them equal on a checked row, so the fixture uses one stamp.
		// (Item b below carries the legitimate re-added shape: last_bought_at
		// alone on an unchecked row.)
		items[0].(map[string]any)["checked"] = true
		items[0].(map[string]any)["checked_at"] = "2026-01-02 10:00:00.000Z"
		items[0].(map[string]any)["last_bought_at"] = "2026-01-02 10:00:00.000Z"
		items[1].(map[string]any)["last_bought_at"] = "2026-01-03 10:00:00.000Z"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(aliceTok))
		newID := listIDOf(t, respBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
		}

		newItems, err := app.FindAllRecords("items", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new items: %v", err)
		}
		if len(newItems) != 3 {
			t.Fatalf("new items count = %d, want 3", len(newItems))
		}
		byName := make(map[string]*core.Record, len(newItems))
		for _, it := range newItems {
			byName[it.GetString("name")] = it
		}

		// (a) checked with both stamps -> restored verbatim.
		itemA := byName["a"]
		if itemA == nil {
			t.Fatalf("imported item %q not found", "a")
		}
		if !itemA.GetBool("checked") {
			t.Errorf("item a checked = false, want true")
		}
		checkedAt, _ := types.ParseDateTime("2026-01-02 10:00:00.000Z")
		if got := itemA.GetDateTime("checked_at"); !got.Time().Equal(checkedAt.Time()) {
			t.Errorf("item a checked_at = %v, want %v", got, checkedAt)
		}
		lastBoughtA, _ := types.ParseDateTime("2026-01-02 10:00:00.000Z")
		if got := itemA.GetDateTime("last_bought_at"); !got.Time().Equal(lastBoughtA.Time()) {
			t.Errorf("item a last_bought_at = %v, want %v", got, lastBoughtA)
		}

		// (b) unchecked but with a last_bought_at -> kept, checked stays false.
		itemB := byName["b"]
		if itemB == nil {
			t.Fatalf("imported item %q not found", "b")
		}
		if itemB.GetBool("checked") {
			t.Errorf("item b checked = true, want false")
		}
		if !itemB.GetDateTime("checked_at").IsZero() {
			t.Errorf("item b checked_at not zero")
		}
		lastBoughtB, _ := types.ParseDateTime("2026-01-03 10:00:00.000Z")
		if got := itemB.GetDateTime("last_bought_at"); !got.Time().Equal(lastBoughtB.Time()) {
			t.Errorf("item b last_bought_at = %v, want %v", got, lastBoughtB)
		}

		// modified_by is the importer, never the file.
		if got := itemA.GetString("modified_by"); got != aliceID {
			t.Errorf("item a modified_by = %q, want %q", got, aliceID)
		}
	})

	t.Run("invalid checked_at", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		attacker := backup["items"].([]any)[0].(map[string]any)
		attacker["checked"] = true
		attacker["checked_at"] = "nope"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid checked_at status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	// null is the same as an absent stamp: never ticked, never bought.
	t.Run("null stamps", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		item := backup["items"].([]any)[0].(map[string]any)
		item["checked_at"] = nil
		item["last_bought_at"] = nil
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Fatalf("null stamps status = %d, want 200: %s", rec.Code, respBody)
		}
		imported, err := app.FindFirstRecordByFilter("items", "list = {:list} && name = 'a'", dbx.Params{"list": listIDOf(t, respBody)})
		if err != nil {
			t.Fatal(err)
		}
		if !imported.GetDateTime("checked_at").IsZero() || !imported.GetDateTime("last_bought_at").IsZero() {
			t.Errorf("null stamps imported as %v / %v, want both unset", imported.GetDateTime("checked_at"), imported.GetDateTime("last_bought_at"))
		}
	})

	t.Run("checked_at without checked", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		attacker := backup["items"].([]any)[0].(map[string]any)
		attacker["checked_at"] = "2026-01-01 10:00:00.000Z" // checked absent
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("checked_at without checked status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	// The three shapes below are unreachable through any server write path
	// ([D-26]: the push route stamps checked_at = last_bought_at with ONE
	// now()) and only a hand-edited document can carry them. Importing one
	// would break the client's §6.10 bucketing seam — e.g. divergent stamps
	// land the same row in the done section AND "Frühere Artikel" at once.
	t.Run("divergent stamp pair", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		attacker := backup["items"].([]any)[0].(map[string]any)
		attacker["checked"] = true
		attacker["checked_at"] = "2026-01-01 10:00:00.000Z"
		attacker["last_bought_at"] = "2026-01-02 10:00:00.000Z"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("divergent stamps status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("checked_at without last_bought_at", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		attacker := backup["items"].([]any)[0].(map[string]any)
		attacker["checked"] = true
		attacker["checked_at"] = "2026-01-01 10:00:00.000Z" // last_bought_at absent
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("checked_at without last_bought_at status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("future last_bought_at", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		attacker := backup["items"].([]any)[0].(map[string]any)
		attacker["last_bought_at"] = time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02 15:04:05.000Z")
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("future last_bought_at status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("name fallback", func(t *testing.T) {
		t.Run("body wins over backup", func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Alice")

			backup := validBackup()
			backup["display_name"] = "BackupName"
			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "BodyName", backup), testutil.AuthHeader(tok))
			newID := listIDOf(t, respBody)
			if rec.Code != http.StatusOK {
				t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
			}
			assertListName(t, app, newID, "BodyName")
		})

		t.Run("backup display_name names the list", func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Alice")

			backup := validBackup()
			backup["display_name"] = "BackupName"
			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
			newID := listIDOf(t, respBody)
			if rec.Code != http.StatusOK {
				t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
			}
			assertListName(t, app, newID, "BackupName")
		})

		t.Run("blank counts as absent at each step", func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Alice")

			backup := validBackup()
			backup["display_name"] = "BackupName"
			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "   ", backup), testutil.AuthHeader(tok))
			if rec.Code != http.StatusOK {
				t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
			}
			assertListName(t, app, listIDOf(t, respBody), "BackupName")

			backup["display_name"] = "  "
			rec, respBody = testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest || !strings.Contains(respBody, "Name is required") {
				t.Fatalf("import status = %d, want 400 name is required: %s", rec.Code, respBody)
			}
		})

		// No name anywhere is refused like a blank name at create: the server
		// holds no UI text to name the list with, and nothing is created.
		t.Run("no name at all is refused", func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Alice")
			listsBefore, _ := app.CountRecords("lists")

			backup := validBackup()
			backup["display_name"] = ""
			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest || !strings.Contains(respBody, "Name is required") {
				t.Fatalf("import status = %d, want 400 name is required: %s", rec.Code, respBody)
			}
			if n, _ := app.CountRecords("lists"); n != listsBefore {
				t.Errorf("lists count = %d, want %d — a refused import created a list", n, listsBefore)
			}
		})

		t.Run("over-cap name is refused", func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Alice")
			max, ok := fieldcontract.MaxBytes("lists", "name")
			if !ok {
				t.Fatal("contract has no lists.name cap")
			}

			// Through the body ...
			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import",
				importBody(t, strings.Repeat("x", max+1), validBackup()), testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("over-cap body name status = %d, want 400: %s", rec.Code, respBody)
			}
			// ... and through the backup's fallback.
			backup := validBackup()
			backup["display_name"] = strings.Repeat("x", max+1)
			rec, respBody = testutil.DoReq(mux, http.MethodPost, "/api/lists/import",
				importBody(t, "", backup), testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("over-cap backup display_name status = %d, want 400: %s", rec.Code, respBody)
			}
			if n, _ := app.CountRecords("lists"); n != 0 {
				t.Errorf("lists = %d after refused imports, want 0", n)
			}

			// Exactly at the cap is fine.
			rec, respBody = testutil.DoReq(mux, http.MethodPost, "/api/lists/import",
				importBody(t, strings.Repeat("x", max), validBackup()), testutil.AuthHeader(tok))
			if rec.Code != http.StatusOK {
				t.Fatalf("at-cap import status = %d, want 200: %s", rec.Code, respBody)
			}
			assertListName(t, app, listIDOf(t, respBody), strings.Repeat("x", max))
		})
	})

	t.Run("envelope validation", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		badFormat := validBackup()
		badFormat["format"] = "x"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", badFormat), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("wrong format status = %d, want 400: %s", rec.Code, respBody)
		}

		badVersion := validBackup()
		badVersion["version"] = fieldcontract.BackupVersion() + 1
		rec, respBody = testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", badVersion), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("wrong version status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("dangling category reference", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		backup["items"].([]any)[0].(map[string]any)["category_key"] = "c9"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("dangling ref status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("oversize item name", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		backup["items"].([]any)[0].(map[string]any)["name"] = strings.Repeat("x", 257) // items.name cap is 256
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("oversize status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	// [D-266] A restored item's photo is the one its barcode has on this
	// server, never the file's image_url.
	t.Run("photo follows the barcode", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")
		photo := testutil.SeedProductPhoto(t, app, "4000417025005")

		backup := validBackup()
		items := backup["items"].([]any)
		a, b := items[0].(map[string]any), items[1].(map[string]any)
		a["barcode"], a["image_url"] = "4000417025005", "https://tracker.example/pixel.gif"
		b["image_url"] = photo
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
		}
		listID := listIDOf(t, respBody)
		for name, want := range map[string]string{"a": photo, "b": ""} {
			got, err := app.FindFirstRecordByFilter("items", "list = {:list} && name = {:name}", dbx.Params{"list": listID, "name": name})
			if err != nil {
				t.Fatal(err)
			}
			if got.GetString("image_url") != want {
				t.Errorf("item %s photo = %q, want %q", name, got.GetString("image_url"), want)
			}
		}
	})

	// The check is the only bound on a category's name, icon and colour: the
	// rows are saved without validation and sync to every member (§8.3).
	t.Run("oversize category fields", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")
		lists, _ := app.CountRecords("lists")

		for _, field := range []string{"name", "icon", "color"} {
			max, _ := fieldcontract.MaxBytes("list_categories", field)
			backup := validBackup()
			backup["categories"].([]any)[0].(map[string]any)[field] = strings.Repeat("x", max+1)
			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("oversize category %s status = %d, want 400: %s", field, rec.Code, respBody)
			}
		}
		if n, _ := app.CountRecords("lists"); n != lists {
			t.Errorf("lists after refused imports = %d, want %d", n, lists)
		}
	})

	// [D-21]: a scanned item's localized names are restored, and capped
	// like name itself. They are optional — a backup without them (every
	// fixture above) still imports.
	t.Run("localized names", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		item := backup["items"].([]any)[0].(map[string]any)
		item["name_de"], item["name_en"] = "a-de", "a-en"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusOK {
			t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
		}
		got, err := app.FindFirstRecordByFilter("items", "list = {:list} && name = 'a'", dbx.Params{"list": listIDOf(t, respBody)})
		if err != nil {
			t.Fatal(err)
		}
		if names := got.GetString("name_de") + "|" + got.GetString("name_en"); names != "a-de|a-en" {
			t.Errorf("imported localized names = %q, want %q", names, "a-de|a-en")
		}

		item["name_en"] = strings.Repeat("x", 257)
		if rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok)); rec.Code != http.StatusBadRequest {
			t.Fatalf("oversize name_en status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("too many items", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		items := make([]any, 0, 2001)
		for range 2001 {
			items = append(items, map[string]any{
				"name": "x", "quantity": "1", "note": nil, "category_key": nil, "barcode": nil, "image_url": nil,
			})
		}
		backup["items"] = items
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("too many items status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("too many categories", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		cats := make([]any, 0, 65)
		for i := range 65 {
			cats = append(cats, map[string]any{
				"key": fmt.Sprintf("c%d", i), "slug": nil, "name": nil, "icon": "icon", "color": "color", "sort_order": i,
			})
		}
		backup["categories"] = cats
		backup["items"] = []any{
			map[string]any{"name": "a", "quantity": "1", "note": nil, "category_key": "c0", "barcode": nil, "image_url": nil},
		}
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("too many categories status = %d, want 400: %s", rec.Code, respBody)
		}
	})

	t.Run("server-stamped fields ignored", func(t *testing.T) {
		app, mux := setupListsApp(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		backup := validBackup()
		attacker := backup["items"].([]any)[0].(map[string]any)
		attacker["name"] = "attacker"
		// checked/checked_at ARE part of the document since [D-72] and come
		// back verbatim — asserted below. Everything here is what must NOT:
		// a record id, the sync-owned columns, and anything unrecognised.
		// The stamp pair is EQUAL: the push route stamps the two with ONE
		// now() ([D-26]) and import rejects any other shape, so a valid
		// document looks like this.
		attacker["checked"] = true
		attacker["checked_at"] = "2026-01-01T00:00:00Z"
		attacker["last_bought_at"] = "2026-01-01T00:00:00Z"
		attacker["id"] = "attackerid123456"
		attacker["modified_by"] = "attackeracct1234"
		attacker["deleted_at"] = "2026-01-01T00:00:00Z"
		attacker["evil"] = "x"
		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
		newID := listIDOf(t, respBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("import status = %d, want 200: %s", rec.Code, respBody)
		}

		newItems, err := app.FindAllRecords("items", dbx.HashExp{"list": newID})
		if err != nil {
			t.Fatalf("find new items: %v", err)
		}
		if len(newItems) != 3 {
			t.Fatalf("new items count = %d, want 3", len(newItems))
		}
		var target *core.Record
		for _, it := range newItems {
			if it.GetString("name") == "attacker" {
				target = it
			}
		}
		if target == nil {
			t.Fatalf("imported item %q not found", "attacker")
		}
		if target.Id == "attackerid123456" {
			t.Errorf("item id = %q, must not be the client-supplied id", target.Id)
		}
		// [D-72]: shopping state is document content and IS restored.
		if !target.GetBool("checked") {
			t.Errorf("item checked = false, want true (state is restored, [D-72])")
		}
		if target.GetDateTime("checked_at").IsZero() {
			t.Errorf("item checked_at is zero, want the document's stamp ([D-72])")
		}
		if target.GetDateTime("last_bought_at").IsZero() {
			t.Errorf("item last_bought_at is zero, want the document's stamp ([D-72])")
		}
		// ...but the sync-owned columns are never adopted from a file: the
		// importer is the modifier, and a restored list has no tombstones.
		if got := target.GetString("modified_by"); got == "attackeracct1234" {
			t.Errorf("item modified_by = %q, must be the importer", got)
		}
		if !target.GetDateTime("deleted_at").IsZero() {
			t.Errorf("item deleted_at was adopted from the file")
		}
	})
}

// TestImportRefusesUnreadableRows ([D-72], [D-08]): rows a genuine export
// cannot contain are refused with 400 before any list exists: a category
// without a key or with another's (the keys are how the file ties items to
// categories), and a
// stamp that is not a date (types.DateTime decodes an unparseable or empty
// string to the zero time without an error, and anything but a string fails
// the body).
func TestImportRefusesUnreadableRows(t *testing.T) {
	cases := []struct {
		name  string
		edit  func(backup map[string]any)
		wants string
	}{
		{"empty category key", func(b map[string]any) {
			b["categories"].([]any)[0].(map[string]any)["key"] = ""
			b["items"].([]any)[0].(map[string]any)["category_key"] = nil // so no reference dangles
		}, "category key is required"},
		{"absent category key", func(b map[string]any) {
			delete(b["categories"].([]any)[0].(map[string]any), "key")
			b["items"].([]any)[0].(map[string]any)["category_key"] = nil
		}, "category key is required"},
		{"unparseable last_bought_at", func(b map[string]any) {
			b["items"].([]any)[1].(map[string]any)["last_bought_at"] = "last Tuesday"
		}, "invalid last_bought_at"},
		// populateList maps a key to one row: items meant for the first
		// category would land in the second.
		{"duplicate category key", func(b map[string]any) {
			b["categories"].([]any)[1].(map[string]any)["key"] = "c0"
			b["items"].([]any)[2].(map[string]any)["category_key"] = nil
		}, "duplicate category key"},
		{"empty last_bought_at", func(b map[string]any) {
			b["items"].([]any)[1].(map[string]any)["last_bought_at"] = ""
		}, "invalid last_bought_at"},
		{"numeric last_bought_at", func(b map[string]any) {
			b["items"].([]any)[1].(map[string]any)["last_bought_at"] = 1767261600
		}, "invalid request body"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			app, mux := setupListsApp(t)
			_, tok := testutil.CreateAccount(t, app, "Alice")
			backup := validBackup()
			c.edit(backup)

			rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/import", importBody(t, "", backup), testutil.AuthHeader(tok))
			if rec.Code != http.StatusBadRequest || !strings.Contains(strings.ToLower(respBody), c.wants) {
				t.Errorf("status = %d %s, want 400 %q", rec.Code, respBody, c.wants)
			}
			for _, col := range []string{"lists", "memberships", "list_categories", "items"} {
				if n, _ := app.CountRecords(col); n != 0 {
					t.Errorf("%d %s rows after a refused import, want 0", n, col)
				}
			}
		})
	}
}
