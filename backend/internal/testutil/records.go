package testutil

import (
	"bytes"
	"log"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/randid"
)

// save writes rec with SaveNoValidate, failing the test on error. Test rows
// are saved directly, bypassing the routes that are not under test.
func save(t *testing.T, app core.App, collection string, set func(*core.Record)) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(collection)
	if err != nil {
		t.Fatalf("find %s collection: %v", collection, err)
	}
	rec := core.NewRecord(col)
	rec.Id = randid.ID()
	set(rec)
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save %s: %v", collection, err)
	}
	return rec
}

// CreateList saves a lists row carrying name ([D-08]) and returns its id.
func CreateList(t *testing.T, app core.App, name string) string {
	t.Helper()
	return save(t, app, "lists", func(r *core.Record) { r.Set("name", name) }).Id
}

// AddMembership saves a memberships row making accountID a member of listID.
func AddMembership(t *testing.T, app core.App, accountID, listID string) *core.Record {
	t.Helper()
	return save(t, app, "memberships", func(r *core.Record) {
		r.Set("account", accountID)
		r.Set("list", listID)
	})
}

// CreateListFor saves a list named name with accountID as its member and
// returns the list id.
func CreateListFor(t *testing.T, app core.App, accountID, name string) string {
	t.Helper()
	listID := CreateList(t, app, name)
	AddMembership(t, app, accountID, listID)
	return listID
}

// CreateCredential saves a credentials row for accountID, with an empty
// credential_json: a passkey that exists, not one that can sign.
func CreateCredential(t *testing.T, app core.App, accountID string) *core.Record {
	t.Helper()
	return save(t, app, "credentials", func(r *core.Record) {
		r.Set("account", accountID)
		r.Set("credential_id", randid.ID())
		r.Set("credential_json", `{}`)
	})
}

// CreateInvite saves an invites row for listID, created by createdBy unless
// that is "".
func CreateInvite(t *testing.T, app core.App, listID, createdBy string) *core.Record {
	t.Helper()
	return save(t, app, "invites", func(r *core.Record) {
		r.Set("list", listID)
		r.Set("token_hash", randid.ID())
		if createdBy != "" {
			r.Set("created_by", createdBy)
		}
	})
}

// Count is the number of collection rows matching exp, failing the test on
// error.
func Count(t *testing.T, app core.App, collection string, exp dbx.Expression) int {
	t.Helper()
	n, err := app.CountRecords(collection, exp)
	if err != nil {
		t.Fatalf("count %s: %v", collection, err)
	}
	return int(n)
}

// CreateItem saves an items row named name on listID; each mutator then
// adjusts the row before it is saved.
func CreateItem(t *testing.T, app core.App, listID, name string, mutators ...func(*core.Record)) *core.Record {
	t.Helper()
	return save(t, app, "items", func(r *core.Record) {
		r.Set("list", listID)
		r.Set("name", name)
		for _, m := range mutators {
			m(r)
		}
	})
}

// CreateListCategory saves a list_categories row with slug on listID.
func CreateListCategory(t *testing.T, app core.App, listID, slug string) *core.Record {
	t.Helper()
	return save(t, app, "list_categories", func(r *core.Record) {
		r.Set("list", listID)
		r.Set("slug", slug)
	})
}

// SeedProductPhoto stores a found product with a photo for ean in
// barcode_cache, as a lookup leaves it, and returns the photo path the lookup
// issues for it: what the server stamps an item with that barcode with
// ([D-266]). The photo field holds a name only; nothing serves the file here.
func SeedProductPhoto(t *testing.T, app core.App, ean string) string {
	t.Helper()
	token := randid.ID()
	save(t, app, "barcode_cache", func(r *core.Record) {
		r.Set("barcode", ean)
		r.Set("found", true)
		r.Set("fetched_at", types.NowDateTime())
		r.Set("photo", "photo.png")
		r.Set("photo_token", token)
	})
	return "/api/barcode/photo/" + token
}

// CaptureLog redirects the standard logger, without its date prefix, into
// the returned buffer for the rest of the test.
func CaptureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev, flags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(prev); log.SetFlags(flags) })
	return &buf
}
