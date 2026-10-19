package sectest

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"testing"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
	"shoppinglist/internal/testutil"
)

// [D-08]. Every write on these routes goes through SaveNoValidate, which skips
// PocketBase's field validation outright, so without bounds of their own a
// 100 KB list id and a 500 KB list name would be stored verbatim on a 200 OK.
// Record ids arrive as `id`/`record_id`, outside the `changed` map the field
// contract's caps cover.
//
// The cost would not land on the attacker. Item ids ride into every member's
// snapshot pull and into the §8.5 digest string the server rebuilds per cycle,
// so one ordinary member of a shared list could make everyone else's sync pull
// megabytes (20 items with 100 KB ids take a co-member's item pull from 8.5 KB
// to 2.0 MB).
//
// The list routes take no id at all (the server mints); push keeps its
// client-minted id — offline creation and [D-42] retry idempotency need it —
// and bounds the shape instead.
func TestUnboundedWritesAreRefused(t *testing.T) {
	huge := strings.Repeat("A", 100_000)

	t.Run("list create ignores a client id and caps the name", func(t *testing.T) {
		app, mux := setupRoutes(t)
		_, tok := testutil.CreateAccount(t, app, "Mallory")
		// Under the route's body limit (security.SmallBodyMax), so the
		// handler's own bounds are what refuse it.
		large := huge[:security.SmallBodyMax/2]

		// A smuggled id must not become the row id.
		body, _ := json.Marshal(map[string]string{"id": large, "name": "Familie"})
		code, resp := do(mux, http.MethodPost, "/api/lists", string(body), tok)
		if code != 200 {
			t.Fatalf("create = %d: %s", code, resp)
		}
		var created struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(resp), &created); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if created.ID == large {
			t.Error("EXPLOITED: the client-supplied id became the list id")
		}
		if len(created.ID) > 64 {
			t.Errorf("server-minted id is %d chars, want a bounded value", len(created.ID))
		}
		var maxID int
		_ = app.DB().NewQuery("SELECT MAX(LENGTH(id)) FROM lists").Row(&maxID)
		if maxID > 64 {
			t.Errorf("EXPLOITED: a %d-char list id reached the database", maxID)
		}

		// An oversized name is refused outright.
		body, _ = json.Marshal(map[string]string{"name": large})
		code, resp = do(mux, http.MethodPost, "/api/lists", string(body), tok)
		if code != 400 {
			t.Errorf("oversized name = %d, want 400: %.120s", code, resp)
		}
		var maxName int
		_ = app.DB().NewQuery("SELECT COALESCE(MAX(LENGTH(name)),0) FROM lists").Row(&maxName)
		if maxName > 1000 {
			t.Errorf("EXPLOITED: a %d-byte list name reached the database", maxName)
		}
	})

	t.Run("import ignores a client id and caps the name", func(t *testing.T) {
		app, mux := setupRoutes(t)
		_, tok := testutil.CreateAccount(t, app, "Mallory")

		backup := map[string]any{
			"format": "einkaufsliste/list-backup", "version": fieldcontract.BackupVersion(),
			"display_name": "B", "categories": []any{}, "items": []any{},
		}
		body, _ := json.Marshal(map[string]any{"id": huge, "name": "Ok", "backup": backup})
		code, resp := do(mux, http.MethodPost, "/api/lists/import", string(body), tok)
		if code != 200 {
			t.Fatalf("import = %d: %s", code, resp)
		}
		var maxID int
		_ = app.DB().NewQuery("SELECT MAX(LENGTH(id)) FROM lists").Row(&maxID)
		if maxID > 64 {
			t.Errorf("EXPLOITED: import stored a %d-char list id", maxID)
		}

		body, _ = json.Marshal(map[string]any{"name": huge, "backup": backup})
		if code, resp = do(mux, http.MethodPost, "/api/lists/import", string(body), tok); code != 400 {
			t.Errorf("import oversized name = %d, want 400: %.120s", code, resp)
		}
		// The backup's own display_name is the fallback name, so it is capped too.
		bigBackup := map[string]any{}
		maps.Copy(bigBackup, backup)
		bigBackup["display_name"] = huge
		body, _ = json.Marshal(map[string]any{"backup": bigBackup})
		if code, resp = do(mux, http.MethodPost, "/api/lists/import", string(body), tok); code != 400 {
			t.Errorf("import oversized backup display_name = %d, want 400: %.120s", code, resp)
		}
		var maxName int
		_ = app.DB().NewQuery("SELECT COALESCE(MAX(LENGTH(name)),0) FROM lists").Row(&maxName)
		if maxName > 1000 {
			t.Errorf("EXPLOITED: import stored a %d-byte list name", maxName)
		}
	})

	t.Run("push refuses an oversized record_id but keeps normal ones", func(t *testing.T) {
		app, mux := setupRoutes(t)
		acctID, tok := testutil.CreateAccount(t, app, "Mallory")
		listID := testutil.CreateList(t, app, "")
		testutil.AddMembership(t, app, acctID, listID)

		// Distinct names per op: an identical name would hit the [D-29]
		// duplicate-name merge and come back "merged", which says nothing about
		// whether the id was accepted.
		n := 0
		push := func(recordID string) string {
			n++
			ops := []map[string]any{{
				"op_id": fmt.Sprintf("op-%d", n), "collection": "items", "record_id": recordID,
				"list_id": listID, "type": "create",
				"changed": map[string]any{"name": fmt.Sprintf("Artikel %d", n)},
			}}
			b, _ := json.Marshal(map[string]any{"ops": ops})
			code, resp := do(mux, http.MethodPost, "/api/sync/push", string(b), tok)
			if code != 200 {
				t.Fatalf("push = %d: %s", code, resp)
			}
			return resp
		}

		if resp := push(huge); !strings.Contains(resp, "bad_record_id") {
			t.Errorf("EXPLOITED: a 100 KB record_id was not denied: %.200s", resp)
		}
		var maxID int
		_ = app.DB().NewQuery("SELECT COALESCE(MAX(LENGTH(id)),0) FROM items").Row(&maxID)
		if maxID > 64 {
			t.Errorf("EXPLOITED: a %d-char item id reached the database", maxID)
		}

		// The formats real clients mint must still work: crypto.randomUUID()
		// (hyphenated, 36) and the Go-side 32-hex convention.
		for _, id := range []string{"f81d4fae-7dec-11d0-a765-00a0c91e6bf6", randid.ID()} {
			if resp := push(id); !strings.Contains(resp, `"applied"`) {
				t.Errorf("legitimate record_id %q was refused: %.200s", id, resp)
			}
		}
	})
}
