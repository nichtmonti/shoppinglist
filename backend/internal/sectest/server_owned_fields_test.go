package sectest

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"

	"shoppinglist/internal/account"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/lists"
	"shoppinglist/internal/security"
	"shoppinglist/internal/sync"
	"shoppinglist/internal/testutil"
	"shoppinglist/seed"
)

// [D-08]. Beyond its server-minted ids and list-name cap: a column the
// client must not be able to name at all, and caps that must hold on every
// door into their column.
//
// setupSeeded is setupRoutes plus the seed and the accounts hooks — the import
// route validates against `category_templates`, and the nickname cap lives in
// account.Register's update guard.
func setupSeeded(t *testing.T) (*pocketbase.PocketBase, http.Handler) {
	t.Helper()
	app := testutil.NewApp(t)
	if err := seed.Run(app); err != nil {
		t.Fatalf("seed.Run: %v", err)
	}
	lists.Register(app)
	account.Register(app, account.Options{Passkeys: true})
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	g := security.AppRoutes(r)
	lists.RegisterRoutes(g, listcap.Default())
	invites.RegisterRoutes(g)
	sync.RegisterRoutes(g, listcap.Default())
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	return app, mux
}

func importBackup(t *testing.T, mux http.Handler, tok string, cats []any) (int, string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"name": "Importiert",
		"backup": map[string]any{
			"format": "einkaufsliste/list-backup", "version": fieldcontract.BackupVersion(),
			"display_name": "Geteilte Liste",
			"categories":   cats,
			"items":        []any{},
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return do(mux, http.MethodPost, "/api/lists/import", string(body), tok)
}

func cat(key string, slug any, name string, order int) map[string]any {
	return map[string]any{
		"key": key, "slug": slug, "name": name,
		"icon": "", "color": "", "sort_order": order,
	}
}

// `slug` is server-owned: §7.5 copies it from category_templates and a
// member-added row leaves it null. Import was the one route that took it from a
// client, and populateList writes with SaveNoValidate — so a crafted backup
// file stored a slug of any length, and could mint any number of rows carrying
// the protected `other` slug that [D-30] makes undeletable.
func TestImportCannotDictateCategorySlug(t *testing.T) {
	t.Run("a slug the server never mints is refused", func(t *testing.T) {
		app, mux := setupSeeded(t)
		_, tok := testutil.CreateAccount(t, app, "Victim")

		huge := strings.Repeat("A", 100_000)
		code, body := importBackup(t, mux, tok, []any{
			cat("k1", huge, "Bloat", 0),
		})
		if code != http.StatusBadRequest {
			t.Errorf("oversized slug = %d, want 400: %.120s", code, body)
		}
		code, body = importBackup(t, mux, tok, []any{
			cat("k1", "definitely-not-a-template-slug", "Made up", 0),
		})
		if code != http.StatusBadRequest {
			t.Errorf("invented slug = %d, want 400: %.120s", code, body)
		}

		var maxSlug int
		_ = app.DB().NewQuery("SELECT COALESCE(MAX(LENGTH(slug)),0) FROM list_categories").Row(&maxSlug)
		if maxSlug > 64 {
			t.Errorf("EXPLOITED: a %d-char client-supplied slug reached the database", maxSlug)
		}
	})

	t.Run("the protected Others slug cannot be multiplied", func(t *testing.T) {
		app, mux := setupSeeded(t)
		_, tok := testutil.CreateAccount(t, app, "Victim")

		// `other` is a real template slug, so one is legitimate — a genuine
		// export carries exactly one. Two is not a list any export can produce,
		// and every one of them would be undeletable ([D-30]).
		code, body := importBackup(t, mux, tok, []any{
			cat("k1", "other", "Sonstiges", 0),
			cat("k2", "other", "Auch Sonstiges", 1),
		})
		if code != http.StatusBadRequest {
			t.Errorf("duplicate slug = %d, want 400: %.120s", code, body)
		}
		n, _ := app.CountRecords("list_categories", dbx.HashExp{"slug": "other"})
		if n != 0 {
			t.Errorf("EXPLOITED: %d forged protected row(s) reached the database", n)
		}
	})

	t.Run("a genuine export still restores", func(t *testing.T) {
		app, mux := setupSeeded(t)
		_, tok := testutil.CreateAccount(t, app, "Alice")

		// What export actually writes: template-copied rows carry a template
		// slug and a null name, member-added rows carry a null slug and a name.
		code, body := importBackup(t, mux, tok, []any{
			cat("k1", "produce", "", 0),
			cat("k2", "other", "", 1),
			cat("k3", nil, "Eigene Kategorie", 2),
		})
		if code != http.StatusOK {
			t.Fatalf("legitimate backup = %d, want 200: %.200s", code, body)
		}
		n, _ := app.CountRecords("list_categories", dbx.HashExp{"slug": "produce"})
		if n != 1 {
			t.Errorf("restored rows with slug=produce = %d, want 1", n)
		}
	})
}

// The [D-08] cap covered the ROUTES that write the list's name. The column's
// other door is the member rename (lists.UpdateRule, [D-08]), where the only
// bound would be PocketBase's TextField default — 5000 characters, ~25x the
// contract's 200 bytes, on the same column. The lists update guard holds that
// door to the same cap, and refuses a blank name.
func TestDirectRenameHonoursTheContractCap(t *testing.T) {
	app, mux := setupSeeded(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateList(t, app, "Familie")
	testutil.AddMembership(t, app, acctID, listID)

	max, ok := fieldcontract.MaxBytes("lists", "name")
	if !ok {
		t.Fatal("contract has no lists.name cap")
	}
	rename := func(name string) (int, string) {
		b, _ := json.Marshal(map[string]string{"name": name})
		return do(mux, http.MethodPatch, "/api/collections/lists/records/"+listID, string(b), tok)
	}
	stored := func() string {
		rec, err := app.FindRecordById("lists", listID)
		if err != nil {
			t.Fatalf("refetch: %v", err)
		}
		return rec.GetString("name")
	}

	if code, body := rename(strings.Repeat("x", max+1)); code != http.StatusBadRequest {
		t.Errorf("over-cap rename = %d, want 400: %.120s", code, body)
	}
	for _, blank := range []string{"", "   "} {
		if code, body := rename(blank); code != http.StatusBadRequest {
			t.Errorf("blank rename %q = %d, want 400: %.120s", blank, code, body)
		}
	}
	if got := stored(); got != "Familie" {
		t.Errorf("a refused rename changed the name to %q", got)
	}

	// The legitimate rename must still work, right up to the cap.
	if code, body := rename(strings.Repeat("x", max)); code != http.StatusOK {
		t.Errorf("at-cap rename = %d, want 200: %.120s", code, body)
	}
	if got := stored(); len(got) != max {
		t.Errorf("stored name is %d bytes, want %d", len(got), max)
	}
}

// nickname is the only user-controlled string this app publishes to OTHER
// people — the §7.4 roster serves it to every co-member — and it had no cap on
// any path.
func TestNicknameHonoursTheContractCap(t *testing.T) {
	app, mux := setupSeeded(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")

	max, ok := fieldcontract.MaxBytes("accounts", "nickname")
	if !ok {
		t.Fatal("contract has no accounts.nickname cap")
	}

	code, body := do(mux, http.MethodPatch,
		"/api/collections/accounts/records/"+acctID,
		`{"nickname":"`+strings.Repeat("y", max+1)+`"}`, tok)
	if code != http.StatusBadRequest {
		t.Errorf("over-cap nickname = %d, want 400: %.120s", code, body)
	}

	code, body = do(mux, http.MethodPatch,
		"/api/collections/accounts/records/"+acctID,
		`{"nickname":"`+strings.Repeat("y", max)+`"}`, tok)
	if code != http.StatusOK {
		t.Errorf("at-cap nickname = %d, want 200: %.120s", code, body)
	}

	var stored int
	_ = app.DB().NewQuery("SELECT COALESCE(MAX(LENGTH(nickname)),0) FROM accounts").Row(&stored)
	if stored > max {
		t.Errorf("stored nickname is %d bytes, cap is %d", stored, max)
	}
}

// The caps bound what a client SENDS, not what the row already holds. Both
// guards therefore compare against the stored value first: a row written before
// [D-08] can carry a longer string, and refusing every later write to it would
// strand the account — `suppressed_names` (§6.11) rides the same own-row update
// as `nickname`, so an unrelated preference change would start failing.
func TestLegacyOversizedValuesDoNotBlockUnrelatedUpdates(t *testing.T) {
	app, mux := setupSeeded(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")

	max, _ := fieldcontract.MaxBytes("accounts", "nickname")
	legacy := strings.Repeat("z", max*2)
	// Raw SQL, because the guard is an OnRecordUpdate HOOK: SaveNoValidate skips
	// PocketBase's field validation but still runs hooks, so even that cannot
	// plant an over-long value. Going under the record pipeline is the only
	// way to reproduce a row written before the cap existed.
	if _, err := app.DB().NewQuery("UPDATE accounts SET nickname = {:n} WHERE id = {:id}").
		Bind(dbx.Params{"n": legacy, "id": acctID}).Execute(); err != nil {
		t.Fatalf("seed legacy nickname: %v", err)
	}

	// An unrelated own-row write must still go through.
	code, body := do(mux, http.MethodPatch,
		"/api/collections/accounts/records/"+acctID,
		`{"suppressed_names":["milch"]}`, tok)
	if code != http.StatusOK {
		t.Errorf("unrelated update on a legacy row = %d, want 200: %.160s", code, body)
	}

	// Changing the nickname itself is still held to the cap.
	code, _ = do(mux, http.MethodPatch,
		"/api/collections/accounts/records/"+acctID,
		`{"nickname":"`+strings.Repeat("q", max+1)+`"}`, tok)
	if code != http.StatusBadRequest {
		t.Errorf("over-cap nickname on a legacy row = %d, want 400", code)
	}

	// And shortening it back into range is exactly how the row is repaired.
	code, body = do(mux, http.MethodPatch,
		"/api/collections/accounts/records/"+acctID,
		`{"nickname":"Alice"}`, tok)
	if code != http.StatusOK {
		t.Errorf("repairing a legacy nickname = %d, want 200: %.160s", code, body)
	}
}

// preview/join hash whatever token arrives. Bounding it must not turn into an
// oracle: a wrong-shaped token and a well-formed unknown one are both simply
// invalid, with the same response.
func TestOversizedInviteTokenIsRefusedWithoutAnOracle(t *testing.T) {
	app, mux := setupSeeded(t)
	_, tok := testutil.CreateAccount(t, app, "Joiner")

	// Under the routes' body limit (security.SmallBodyMax), so the handler's
	// own cap on the token is what refuses it.
	oversized, _ := json.Marshal(map[string]string{"token": strings.Repeat("t", security.SmallBodyMax/2)})
	unknown, _ := json.Marshal(map[string]string{"token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ"})

	for _, route := range []string{"/api/invites/preview", "/api/invites/join"} {
		codeBig, bodyBig := do(mux, http.MethodPost, route, string(oversized), tok)
		codeUnk, bodyUnk := do(mux, http.MethodPost, route, string(unknown), tok)
		if codeBig != http.StatusBadRequest {
			t.Errorf("%s oversized token = %d, want 400: %.120s", route, codeBig, bodyBig)
		}
		if codeBig != codeUnk || bodyBig != bodyUnk {
			t.Errorf("%s distinguishes a malformed token from an unknown one:\n oversized: %d %s\n unknown:   %d %s",
				route, codeBig, bodyBig, codeUnk, bodyUnk)
		}
	}
	if n, _ := app.CountRecords("memberships", dbx.HashExp{}); n != 0 {
		t.Errorf("a refused join created %d membership(s)", n)
	}
}
