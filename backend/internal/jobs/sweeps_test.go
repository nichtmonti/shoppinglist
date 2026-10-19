package jobs

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/account"
	"shoppinglist/internal/barcode"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/lists"
	"shoppinglist/internal/sync"
	"shoppinglist/internal/testutil"
	_ "shoppinglist/migrations"
)

// Behavioural coverage for the §13 sweeps. Every one of them DELETEs, so
// each test asserts both halves: what the job must remove AND what it must
// leave alone — the second half is the one that matters, since the failure mode
// is destroying live user data.
//
// jobs_test.go's TestRegisterAddsAllJobs only proves the schedules parse; it
// cannot see whether a job does anything at all. the orphan sweep silently did
// nothing for four phases behind exactly that gap.

func newApp(t *testing.T) core.App {
	t.Helper()
	return testutil.NewApp(t)
}

// pinStoragePrefix gives a record that never stored a real file a placeholder
// one under its storage prefix, on the local driver's exact path, and is the
// signal waitForStoragePrefixGone polls — a bare directory prefix is not a
// blob (fileblob's Exists is file-only), so polling the prefix itself never
// observes anything. Why the pin matters: PocketBase deletes a deleted
// record's storage prefix from an OnModelAfterDeleteSuccess hook via
// routine.FireAndForget, and that goroutine MkdirAll's the storage root
// before listing — for a fileless record there is nothing to wait for, the
// test returns, and the pending goroutine can re-create "<dataDir>/storage"
// inside t.TempDir cleanup's removal window ("unlinkat .../001: directory
// not empty" — Go numbers every t.TempDir call, and 001 IS the data dir).
// The pin gives the goroutine a file it must delete, so waiting for the pin
// to vanish also waits for the goroutine's filesystem phase — its MkdirAll
// has necessarily already run. A sleep cannot fix this; only a dependent
// event can.
func pinStoragePrefix(t *testing.T, app core.App, record *core.Record) {
	t.Helper()
	dir := filepath.Join(app.DataDir(), "storage", record.BaseFilesPath())
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		t.Fatalf("pin storage prefix: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".pin"), nil, os.ModePerm); err != nil {
		t.Fatalf("pin storage prefix: %v", err)
	}
}

func save(t *testing.T, app core.App, col string, kv map[string]any) *core.Record {
	t.Helper()
	c, err := app.FindCollectionByNameOrId(col)
	if err != nil {
		t.Fatalf("collection %s: %v", col, err)
	}
	r := core.NewRecord(c)
	for k, v := range kv {
		r.Set(k, v)
	}
	if err := app.SaveNoValidate(r); err != nil {
		t.Fatalf("save %s: %v", col, err)
	}
	return r
}

// backdate rewrites the autodate columns that PB always stamps to now, as if
// the row was last saved d from now.
func backdate(t *testing.T, app core.App, table, id string, d time.Duration) {
	t.Helper()
	ts, _ := types.ParseDateTime(time.Now().Add(d))
	if _, err := app.DB().NewQuery(
		"UPDATE {{" + table + "}} SET created = {:c}, updated = {:c} WHERE id = {:id}",
	).Bind(map[string]any{"c": ts.String(), "id": id}).Execute(); err != nil {
		t.Fatalf("backdate %s: %v", table, err)
	}
}

func ago(d time.Duration) string {
	ts, _ := types.ParseDateTime(time.Now().Add(-d))
	return ts.String()
}

func exists(t *testing.T, app core.App, col, id string) bool {
	t.Helper()
	_, err := app.FindRecordById(col, id)
	return err == nil
}

const day = 24 * time.Hour

// mustSweep runs one §13 sweep and fails the test on its error.
func mustSweep(t *testing.T, app core.App, sweep func(core.App) error) {
	t.Helper()
	if err := sweep(app); err != nil {
		t.Fatalf("sweep: %v", err)
	}
}

// waitForStoragePrefixGone waits out PocketBase's post-delete storage cleanup:
// it deletes the record's whole storage prefix via routine.FireAndForget —
// off the delete transaction — so the deletion lands on disk shortly after
// the row, and the dependent event is the PIN FILE disappearing (a directory
// prefix is not a blob, so it cannot be polled directly — see
// pinStoragePrefix). Callers must pinStoragePrefix the record beforehand;
// waiting also waits out the background goroutine's lazy MkdirAll of the
// storage root, which would otherwise race t.TempDir's cleanup RemoveAll
// ("directory not empty" instead of a real assertion).
func waitForStoragePrefixGone(t *testing.T, app core.App, record *core.Record) {
	t.Helper()
	prefix := record.BaseFilesPath()
	if prefix == "" {
		return
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		t.Fatalf("filesystem: %v", err)
	}
	defer fsys.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		gone, _ := fsys.Exists(prefix + "/.pin")
		if !gone {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("storage prefix %s still present after the delete", prefix)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTombstoneGCSparesLiveRows(t *testing.T) {
	app := newApp(t)
	list := save(t, app, "lists", map[string]any{})

	old := save(t, app, "items", map[string]any{"list": list.Id, "name": "alt", "deleted_at": ago(200 * day)})
	recent := save(t, app, "items", map[string]any{"list": list.Id, "name": "neu", "deleted_at": ago(10 * day)})
	active := save(t, app, "items", map[string]any{"list": list.Id, "name": "aktiv"})
	// §6.10: a removed row the list still REMEMBERS BUYING is its "Frühere
	// Artikel" entry — there is no separate history record — so the horizon must
	// not quietly eat a household's re-buy memory six months after the row left
	// the list. Spared regardless of age.
	remembered := save(t, app, "items", map[string]any{
		"list": list.Id, "name": "gekauft",
		"deleted_at": ago(200 * day), "last_bought_at": ago(200 * day),
	})
	oldCat := save(t, app, "list_categories", map[string]any{"list": list.Id, "name": "Eigene", "deleted_at": ago(200 * day)})
	// [D-251]: a removed template aisle keeps its slug, or the missing-
	// categories button would offer it again.
	removedTemplate := save(t, app, "list_categories", map[string]any{"list": list.Id, "slug": "x", "deleted_at": ago(200 * day)})
	activeCat := save(t, app, "list_categories", map[string]any{"list": list.Id, "slug": "y"})

	mustSweep(t, app, sync.SweepTombstones)

	if exists(t, app, "items", old.Id) {
		t.Error("180-day-old tombstone survived")
	}
	if !exists(t, app, "items", recent.Id) {
		t.Error("10-day-old tombstone deleted too early")
	}
	if !exists(t, app, "items", active.Id) {
		t.Error("ACTIVE ITEM DELETED by tombstone GC")
	}
	if !exists(t, app, "items", remembered.Id) {
		t.Error("REMEMBERED tombstone (last_bought_at set) deleted by tombstone GC")
	}
	if exists(t, app, "list_categories", oldCat.Id) {
		t.Error("old category tombstone survived")
	}
	if !exists(t, app, "list_categories", removedTemplate.Id) {
		t.Error("removed template category (slug set) deleted by tombstone GC")
	}
	if !exists(t, app, "list_categories", activeCat.Id) {
		t.Error("ACTIVE CATEGORY DELETED by tombstone GC")
	}
}

// TestTombstoneGCClearHistoryRearmsTheExemption pins [D-100] end to end: the
// §13 exemption keys on the very stamp §7.5's clear-history route nulls, so a
// household reset deliberately hands a remembered tombstone back to the sweep.
// The route half and the sweep half are each tested where they live
// (lists/clearhistory_test.go; above) — this is the CONJUNCTION, the real
// route followed by the real sweep, because "the reset purges removed-but-
// bought articles" is a decision about their interaction, not about either
// half. If this ever fails "unexpectedly", the behavior changed, not the test.
func TestTombstoneGCClearHistoryRearmsTheExemption(t *testing.T) {
	app, mux := testutil.NewMux(t, func(r *router.RouterGroup[*core.RequestEvent]) {
		lists.RegisterRoutes(r, listcap.Default())
	})
	aliceID, aliceTok := testutil.CreateAccount(t, app, "Alice")

	list := save(t, app, "lists", map[string]any{})
	save(t, app, "memberships", map[string]any{"account": aliceID, "list": list.Id})
	remembered := save(t, app, "items", map[string]any{
		"list": list.Id, "name": "Haselnussmus",
		"deleted_at": ago(200 * day), "last_bought_at": ago(200 * day),
	})

	mustSweep(t, app, sync.SweepTombstones)
	if !exists(t, app, "items", remembered.Id) {
		t.Fatal("remembered tombstone deleted BEFORE the clear — fixture does not represent §6.10 history")
	}

	rec, body := testutil.DoReq(mux, http.MethodPost, "/api/lists/"+list.Id+"/clear-history", "", testutil.AuthHeader(aliceTok))
	if rec.Code != http.StatusOK {
		t.Fatalf("clear-history status = %d, want 200: %s", rec.Code, body)
	}

	mustSweep(t, app, sync.SweepTombstones)
	if exists(t, app, "items", remembered.Id) {
		t.Error("remembered tombstone survived clear-history + GC — [D-100] broken: the row left §6.10 history but the sweep still spares it")
	}
}

func TestInviteSweepRespectsRetentionWindows(t *testing.T) {
	app := newApp(t)

	// Each NON-revoked fixture needs its own list: [D-31] added a partial
	// unique index (one live invite per list), and the sweep is list-agnostic,
	// so spreading them out preserves what this test is actually about.
	// The two revoked rows can share a list — the index excludes them.
	newList := func() string { return save(t, app, "lists", map[string]any{}).Id }
	shared := newList()

	longExpired := save(t, app, "invites", map[string]any{"list": newList(), "token_hash": "a", "expires_at": ago(40 * day)})
	justExpired := save(t, app, "invites", map[string]any{"list": newList(), "token_hash": "b", "expires_at": ago(2 * day)})
	live := save(t, app, "invites", map[string]any{"list": newList(), "token_hash": "c", "expires_at": ago(-5 * day)})
	revokedOld := save(t, app, "invites", map[string]any{"list": shared, "token_hash": "d", "revoked": true, "expires_at": ago(-5 * day)})
	backdate(t, app, "invites", revokedOld.Id, -40*day)
	revokedNew := save(t, app, "invites", map[string]any{"list": shared, "token_hash": "e", "revoked": true, "expires_at": ago(-5 * day)})
	// A link made 40 days ago and revoked today is 0 days revoked.
	oldLink := newList()
	revokedToday := save(t, app, "invites", map[string]any{"list": oldLink, "token_hash": "f", "expires_at": ago(-5 * day)})
	backdate(t, app, "invites", revokedToday.Id, -40*day)
	if n, err := invites.RevokeLive(app, oldLink); err != nil || n != 1 {
		t.Fatalf("RevokeLive = %d, %v; want 1", n, err)
	}

	mustSweep(t, app, invites.Sweep)

	if exists(t, app, "invites", longExpired.Id) {
		t.Error("invite expired 40 days ago survived")
	}
	if !exists(t, app, "invites", justExpired.Id) {
		t.Error("invite expired 2 days ago deleted (retention is 30 days after expiry)")
	}
	if !exists(t, app, "invites", live.Id) {
		t.Error("LIVE INVITE DELETED")
	}
	if exists(t, app, "invites", revokedOld.Id) {
		t.Error("invite revoked >30 days ago survived")
	}
	if !exists(t, app, "invites", revokedNew.Id) {
		t.Error("freshly revoked invite deleted too early")
	}
	if !exists(t, app, "invites", revokedToday.Id) {
		t.Error("an old link revoked today was deleted: its age must count from the revocation")
	}
}

func TestOrphanSweepDeletesOrphansAndSparesTheRest(t *testing.T) {
	app := newApp(t)
	// The production guards, as main binds them: the last-credential guard
	// refuses the credential cascade of a plain app.Delete(account).
	account.Register(app, account.Options{Passkeys: true})
	list := save(t, app, "lists", map[string]any{})

	mk := func(handle string) *core.Record {
		return save(t, app, "accounts", map[string]any{
			"handle": handle, "nickname": handle, "password": "12345678901234", "tokenKey": handle + "tokenkeytokenkey",
		})
	}

	// (a) old, no membership, credential last used long ago -> must be deleted
	orphan := mk("orphan")
	backdate(t, app, "accounts", orphan.Id, -70*day)
	orphanCred := save(t, app, "credentials", map[string]any{
		"account": orphan.Id, "credential_id": "c1", "credential_json": `{}`, "last_used_at": ago(70 * day),
	})

	// (b) old, no membership, but recently used -> must survive
	activeUser := mk("activeuser")
	backdate(t, app, "accounts", activeUser.Id, -70*day)
	save(t, app, "credentials", map[string]any{
		"account": activeUser.Id, "credential_id": "c2", "credential_json": `{}`, "last_used_at": ago(2 * day),
	})

	// (c) old, stale credential, but HAS a membership -> must survive
	member := mk("member")
	backdate(t, app, "accounts", member.Id, -70*day)
	save(t, app, "credentials", map[string]any{
		"account": member.Id, "credential_id": "c3", "credential_json": `{}`, "last_used_at": ago(70 * day),
	})
	save(t, app, "memberships", map[string]any{"account": member.Id, "list": list.Id})

	// (d) new account, no membership, no credential yet -> must survive
	newbie := mk("newbie")

	mustSweep(t, app, account.SweepOrphans)

	if exists(t, app, "accounts", orphan.Id) {
		t.Error("orphan account survived the sweep")
	}
	if exists(t, app, "credentials", orphanCred.Id) {
		t.Error("orphan's credential was not cascade-deleted")
	}
	if !exists(t, app, "accounts", activeUser.Id) {
		t.Error("ACTIVE USER DELETED — recent last_used_at did not protect the account")
	}
	if !exists(t, app, "accounts", member.Id) {
		t.Error("LIST MEMBER DELETED — membership did not protect the account")
	}
	if !exists(t, app, "accounts", newbie.Id) {
		t.Error("BRAND-NEW ACCOUNT DELETED — the 60-day age guard did not hold")
	}
}

// barcode.SweepPhotos is the one sweep whose point is disk
// rather than rows: it exists so the stored product photos ([D-21]) cannot grow
// without bound. The file-deletion half is the part worth pinning — a raw SQL
// DELETE would drop the row and orphan the JPEG forever, which is the leak the
// job is for.
func TestBarcodePhotoSweepDropsStaleEntriesAndTheirFiles(t *testing.T) {
	app := newApp(t)

	png, err := filesystem.NewFileFromBytes([]byte{
		0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	}, "stale.png")
	if err != nil {
		t.Fatal(err)
	}
	stale := save(t, app, "barcode_cache", map[string]any{
		"barcode": "1111111111111", "found": true, "name": "Alt",
		"fetched_at": ago(200 * day), "photo": png, "photo_token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	staleFile := stale.BaseFilesPath() + "/" + stale.GetString("photo")

	// 100 days is past the 30-day positive TTL — refetched on demand, but NOT
	// old enough to be swept. This is the boundary the job must not overrun.
	fresh := save(t, app, "barcode_cache", map[string]any{
		"barcode": "2222222222222", "found": true, "name": "Neu", "fetched_at": ago(100 * day),
	})

	fsys, err := app.NewFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	if exists, _ := fsys.Exists(staleFile); !exists {
		t.Fatalf("setup: photo was never stored at %s", staleFile)
	}

	mustSweep(t, app, barcode.SweepPhotos)

	if exists(t, app, "barcode_cache", stale.Id) {
		t.Error("stale barcode_cache entry survived the sweep")
	}
	if !exists(t, app, "barcode_cache", fresh.Id) {
		t.Error("100-DAY-OLD ENTRY DELETED — the 180-day guard did not hold")
	}
	// PocketBase deletes a record's files from an OnModelAfterDeleteSuccess hook
	// via routine.FireAndForget — deliberately "optimistic" and off the delete
	// transaction — so the file goes away shortly after the row, not with it.
	// Poll rather than assert immediately; a bare check races and passes ~1 in 5.
	deadline := time.Now().Add(5 * time.Second)
	for {
		gone, _ := fsys.Exists(staleFile)
		if !gone {
			break
		}
		if time.Now().After(deadline) {
			t.Error("PHOTO ORPHANED ON DISK — the row went but the file stayed")
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The sweep is age-based, but age is the wrong test on its own: an item holds
// the photo's token URL in image_url (§9.2), and a product scanned once and
// kept on a list for six months would otherwise have its picture blanked by its
// own cache entry ageing out.
func TestBarcodePhotoSweepSparesPhotosAnItemStillUses(t *testing.T) {
	app := newApp(t)

	referenced := save(t, app, "barcode_cache", map[string]any{
		"barcode": "3333333333333", "found": true, "name": "Benutzt",
		"fetched_at": ago(400 * day), "photo_token": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	unreferenced := save(t, app, "barcode_cache", map[string]any{
		"barcode": "4444444444444", "found": true, "name": "Verwaist",
		"fetched_at": ago(400 * day), "photo_token": "cccccccccccccccccccccccccccccccc",
	})
	// The sweep deletes this row via app.Delete, whose storage cleanup runs
	// on a FireAndForget goroutine — pin its prefix so the wait below covers
	// that goroutine instead of resolving instantly (see pinStoragePrefix).
	pinStoragePrefix(t, app, unreferenced)

	owner := save(t, app, "accounts", map[string]any{"handle": "sweep-owner", "nickname": "Owner"})
	list := save(t, app, "lists", map[string]any{"owner": owner.Id, "name": "L"})
	save(t, app, "items", map[string]any{
		"list": list.Id, "name": "Sonnencreme",
		"image_url": "/api/barcode/photo/" + referenced.GetString("photo_token"),
	})

	mustSweep(t, app, barcode.SweepPhotos)

	if !exists(t, app, "barcode_cache", referenced.Id) {
		t.Error("LIVE ITEM'S PHOTO DELETED — the picture on an existing item just went blank")
	}
	if exists(t, app, "barcode_cache", unreferenced.Id) {
		t.Error("unreferenced stale entry survived the sweep")
	}
	waitForStoragePrefixGone(t, app, unreferenced)
}

// image_url is server-stamped from the barcode ([D-266]), but a dashboard edit
// or a row from before that holds any value, so the reference check must be
// equality against the exact URL the server issues. A suffix match would let
// such a row pin a cache row — and its disk — forever.
func TestBarcodePhotoSweepIgnoresCraftedImageURLs(t *testing.T) {
	app := newApp(t)

	stale := save(t, app, "barcode_cache", map[string]any{
		"barcode": "5555555555555", "found": true, "name": "Alt",
		"fetched_at": ago(400 * day), "photo_token": "dddddddddddddddddddddddddddddddd",
	})
	pinStoragePrefix(t, app, stale)
	owner := save(t, app, "accounts", map[string]any{"handle": "pin-owner", "nickname": "Owner"})
	list := save(t, app, "lists", map[string]any{"owner": owner.Id, "name": "L"})
	// Ends with the token, but is not the URL the server ever issues.
	save(t, app, "items", map[string]any{
		"list": list.Id, "name": "Pin",
		"image_url": "https://evil.test/" + stale.GetString("photo_token"),
	})

	mustSweep(t, app, barcode.SweepPhotos)

	if exists(t, app, "barcode_cache", stale.Id) {
		t.Error("a crafted image_url pinned a stale cache row — client input steers the sweep")
	}

	waitForStoragePrefixGone(t, app, stale)
}

// TestMergeLogSweepRespectsTheRetryHorizon: the [D-108] merge log is what makes
// a retried duplicate-name create replay instead of merging twice, so a row is
// useful for as long as some offline client might still retry. The horizon is
// the tombstone horizon, 180 days, deliberately — expiring a row re-exposes the
// exact defect the log exists to prevent.
func TestMergeLogSweepRespectsTheRetryHorizon(t *testing.T) {
	app := newApp(t)
	list := save(t, app, "lists", map[string]any{})

	old := save(t, app, "merge_log", map[string]any{
		"list": list.Id, "survivor": "survivor-a", "merged_at": ago(200 * day),
	})
	recent := save(t, app, "merge_log", map[string]any{
		"list": list.Id, "survivor": "survivor-b", "merged_at": ago(30 * day),
	})

	mustSweep(t, app, sync.SweepMergeLog)

	if exists(t, app, "merge_log", old.Id) {
		t.Error("merge-log row from 200 days ago survived")
	}
	if !exists(t, app, "merge_log", recent.Id) {
		t.Error("merge-log row from 30 days ago deleted — a retry would now merge twice")
	}
}
