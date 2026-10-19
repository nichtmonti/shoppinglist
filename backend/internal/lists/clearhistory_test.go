package lists

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/listcap"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/sync"
	"shoppinglist/internal/testutil"
)

// TestClearHistory (§7.5 [D-79]): POST /api/lists/{listId}/clear-history nulls
// checked_at and last_bought_at on every item — tombstoned rows included — in
// one transaction, leaves checked untouched (current trip state is not
// history), and bumps updated so every member's digest diverges and the
// snapshot repair converges them. For a tombstoned row the nulling is a
// deliberate purge, not just a hint-clear ([D-100]): the stamp was its §6.10
// history membership and its §13 GC exemption. The conjunction — cleared
// stamp, then the sweep taking the row — is pinned in jobs/sweeps_test.go.
func TestClearHistory(t *testing.T) {
	t.Run("member clears history", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

		listID := testutil.CreateList(t, app, "")
		testutil.AddMembership(t, app, aliceID, listID)

		checkedAt, _ := types.ParseDateTime("2026-01-01 10:00:00.000Z")
		lastBought, _ := types.ParseDateTime("2026-01-02 10:00:00.000Z")
		// (a) checked with both stamps, (b) unchecked with last_bought_at,
		// (c) tombstoned with stamps — the [D-100] case: on such a row the
		// clear purges the article (it leaves §6.10 history and re-arms the
		// §13 GC), it does not merely undate it.
		addTestItem(t, app, listID, func(r *core.Record) {
			r.Set("name", "a")
			r.Set("checked", true)
			r.Set("checked_at", checkedAt)
			r.Set("last_bought_at", lastBought)
		})
		addTestItem(t, app, listID, func(r *core.Record) {
			r.Set("name", "b")
			r.Set("last_bought_at", lastBought)
		})
		addTestItem(t, app, listID, func(r *core.Record) {
			r.Set("name", "c")
			r.Set("checked", true)
			r.Set("checked_at", checkedAt)
			r.Set("last_bought_at", lastBought)
			r.Set("deleted_at", types.NowDateTime())
		})

		// Pin the fixture rows' `updated` to a fixed past stamp, via raw SQL —
		// a record save would autodate-stamp it at the current millisecond.
		// clearHistory re-stamps with types.NowDateTime(), also at millisecond
		// precision: when a row's creation stamp and the request's `now` land
		// in the same millisecond, the two strings compare EQUAL and the
		// "updated not bumped" assertion below fires on a healthy build. That
		// same-millisecond collision is a shape §8.5's client ladder already
		// treats as normal operation (snapshot.ts's delta-verify fallback); a
		// fixed past stamp makes it impossible here instead of merely unlikely
		// — a CI runner fast enough to clear-history within 1ms of the fixture
		// write has been observed (release build, v0.2.0).
		if _, err := app.DB().NewQuery(
			"UPDATE items SET updated = {:u} WHERE list = {:list}",
		).Bind(dbx.Params{"u": checkedAt.String(), "list": listID}).Execute(); err != nil {
			t.Fatalf("backdate fixture updated: %v", err)
		}

		before, err := app.FindAllRecords("items", dbx.HashExp{"list": listID})
		if err != nil {
			t.Fatalf("find items before: %v", err)
		}
		updatedBefore := make(map[string]string, len(before))
		for _, it := range before {
			updatedBefore[it.Id] = it.GetString("updated")
		}

		rec, respBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+listID+"/clear-history", "", testutil.AuthHeader(aliceTok))
		if rec.Code != http.StatusOK {
			t.Fatalf("clear-history status = %d, want 200: %s", rec.Code, respBody)
		}
		if strings.TrimSpace(respBody) != `{"cleared":3}` {
			t.Errorf("response body = %q, want %q", respBody, `{"cleared":3}`)
		}

		after, err := app.FindAllRecords("items", dbx.HashExp{"list": listID})
		if err != nil {
			t.Fatalf("find items after: %v", err)
		}
		if len(after) != 3 {
			t.Fatalf("items count = %d, want 3", len(after))
		}
		byName := make(map[string]*core.Record, len(after))
		for _, it := range after {
			byName[it.GetString("name")] = it
		}
		// All three rows — tombstoned included — have zero stamps; checked is
		// untouched; updated bumped.
		for name, wantChecked := range map[string]bool{"a": true, "b": false, "c": true} {
			it := byName[name]
			if it == nil {
				t.Fatalf("item %q not found", name)
			}
			if !it.GetDateTime("checked_at").IsZero() {
				t.Errorf("item %s checked_at not zero", name)
			}
			if !it.GetDateTime("last_bought_at").IsZero() {
				t.Errorf("item %s last_bought_at not zero", name)
			}
			if got := it.GetBool("checked"); got != wantChecked {
				t.Errorf("item %s checked = %v, want %v", name, got, wantChecked)
			}
			if got := it.GetString("updated"); got == updatedBefore[it.Id] {
				t.Errorf("item %s updated not bumped (%q)", name, got)
			}
		}
	})

	t.Run("non-member and nonexistent list 403 byte-identical", func(t *testing.T) {
		app, mux := setupListsApp(t)
		aliceID, _ := testutil.CreateAccount(t, app, "Alice")
		_, soloTok := testutil.CreateAccount(t, app, "Solo")

		listID := testutil.CreateList(t, app, "")
		testutil.AddMembership(t, app, aliceID, listID)
		addTestItem(t, app, listID)

		nonMemberRec, nonMemberBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+listID+"/clear-history", "", testutil.AuthHeader(soloTok))
		if nonMemberRec.Code != http.StatusForbidden {
			t.Fatalf("non-member clear-history status = %d, want 403: %s", nonMemberRec.Code, nonMemberBody)
		}

		// A listId that doesn't exist at all gets the identical 403 — the route
		// must not be usable to enumerate list existence.
		ghostRec, ghostBody := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+randid.ID()+"/clear-history", "", testutil.AuthHeader(soloTok))
		if ghostRec.Code != http.StatusForbidden {
			t.Fatalf("nonexistent-list clear-history status = %d, want 403: %s", ghostRec.Code, ghostBody)
		}
		if ghostBody != nonMemberBody {
			t.Errorf("nonexistent-list body = %q, want byte-identical to non-member body %q", ghostBody, nonMemberBody)
		}
	})
}

// TestClearHistoryMovesTheDigest is the anti-silent-divergence guard for the
// one raw UPDATE this codebase runs against a collection the §8.5 digest
// covers.
//
// The digest is sha256 over the list's sorted `{id}:{updated}` pairs, so it can
// only ever detect a change that `updated` reflects. `updated` is stamped by
// PocketBase's autodate on SAVE — the database does not maintain it — so a raw
// UPDATE that forgets to set it mutates the rows while leaving the digest
// byte-identical. Every client would then agree it is in sync while showing
// purchase dates the server no longer has, and no amount of polling would
// notice: the repair only runs on a digest mismatch. That is a permanent silent
// divergence, and it is one deleted line away.
//
// Deleting the `updated` assignment from clearHistory's statement makes this fail.
// Every other raw-SQL mutation in the codebase is either a DELETE (the row
// leaves the id set, so the hash moves on its own) or targets a collection the
// digest does not cover (invites, lists, barcode_cache).
func TestClearHistoryMovesTheDigest(t *testing.T) {
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		RegisterRoutes(r, listcap.Default())
		sync.RegisterRoutes(r, listcap.Default())
	})
	aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, aliceID, listID)

	stamp, _ := types.ParseDateTime("2026-01-01 10:00:00.000Z")
	col, err := app.FindCollectionByNameOrId("items")
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}
	for i, name := range []string{"Milch", "Brot", "Butter"} {
		rec := core.NewRecord(col)
		rec.Set("list", listID)
		rec.Set("name", name)
		if i == 0 { // only one row has ever been bought
			rec.Set("checked", true)
			rec.Set("checked_at", stamp)
			rec.Set("last_bought_at", stamp)
		}
		if err := app.SaveNoValidate(rec); err != nil {
			t.Fatalf("save item: %v", err)
		}
	}

	// Same-millisecond guard as in TestClearHistory above: the digest can only
	// move if Milch's `updated` string actually changes, and a fixture created
	// in the same millisecond the request's types.NowDateTime() reads would
	// make the "digest unchanged" failure fire on a healthy build.
	if _, err := app.DB().NewQuery(
		"UPDATE items SET updated = {:u} WHERE list = {:list}",
	).Bind(dbx.Params{"u": stamp.String(), "list": listID}).Execute(); err != nil {
		t.Fatalf("backdate fixture updated: %v", err)
	}

	digest := func() string {
		t.Helper()
		rec, body := testutil.DoReq(mux, http.MethodGet, "/api/sync/digest", "", testutil.AuthHeader(aliceTok))
		if rec.Code != http.StatusOK {
			t.Fatalf("digest status = %d: %s", rec.Code, body)
		}
		var entries []struct {
			ListID string `json:"list_id"`
			Hash   string `json:"hash"`
		}
		if err := json.Unmarshal([]byte(body), &entries); err != nil {
			t.Fatalf("decode digest: %v (%s)", err, body)
		}
		for _, d := range entries {
			if d.ListID == listID {
				return d.Hash
			}
		}
		t.Fatalf("no digest entry for list %s: %s", listID, body)
		return ""
	}

	before := digest()

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+listID+"/clear-history", "", testutil.AuthHeader(aliceTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("clear-history status = %d: %s", rec.Code, body)
	}

	after := digest()
	if after == before {
		t.Errorf("digest unchanged after clear-history (%s) — the cleared rows' `updated` did not move, "+
			"so every client will believe it is in sync while holding purchase dates the server has erased", after)
	}

	// And a no-op clear must NOT move it: bumping `updated` on rows nothing
	// changed on would drag the whole list through a pointless delta pull.
	steady := digest()
	rec, body = testutil.DoReq(mux, http.MethodPost, "/api/lists/"+listID+"/clear-history", "", testutil.AuthHeader(aliceTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("second clear-history status = %d: %s", rec.Code, body)
	}
	if digest() != steady {
		t.Errorf("digest moved on a clear that had nothing to clear — unchanged rows are being re-stamped")
	}
}

// A row whose stamp is at or past the clock (the sync stamp hook keeps a busy
// row's `updated` a millisecond ahead) must still get a new one: the clear
// would otherwise change the row but not its digest pair.
func TestClearHistoryMovesAStampAheadOfTheClock(t *testing.T) {
	app, mux := setupListsApp(t)
	aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateList(t, app, "")
	testutil.AddMembership(t, app, aliceID, listID)
	item := testutil.CreateItem(t, app, listID, "Milch", func(r *core.Record) {
		r.Set("checked", true)
		r.Set("checked_at", "2026-01-01 10:00:00.000Z")
		r.Set("last_bought_at", "2026-01-01 10:00:00.000Z")
	})
	ahead := types.NowDateTime().Add(time.Hour).String()
	if _, err := app.DB().NewQuery("UPDATE items SET updated = {:u} WHERE id = {:id}").
		Bind(dbx.Params{"u": ahead, "id": item.Id}).Execute(); err != nil {
		t.Fatal(err)
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+listID+"/clear-history", "", testutil.AuthHeader(aliceTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, body)
	}
	fresh, err := app.FindRecordById("items", item.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := fresh.GetString("updated"); got <= ahead {
		t.Fatalf("updated = %s, want after %s", got, ahead)
	}
	if fresh.GetString("last_bought_at") != "" {
		t.Fatalf("last_bought_at = %q, want cleared", fresh.GetString("last_bought_at"))
	}
}
