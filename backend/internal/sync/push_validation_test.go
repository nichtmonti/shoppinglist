package sync

import (
	"testing"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// The field allowlist and shape checks (§8.3 step 1: this route is the single
// write enforcement point).

// TestPush_Create_SmuggledListDenied: a member of list A cannot write into list B
// by putting `list` in `changed` — the op's authorised scope is list_id alone.
func TestPush_Create_SmuggledListDenied(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	bob, _ := testutil.CreateAccount(t, app, "Bob")
	listA := testutil.CreateListFor(t, app, alice, "Test")
	listB := testutil.CreateListFor(t, app, bob, "Test") // Alice is NOT a member

	itemID := randid.ID()
	results := push(t, mux, tok, []pushOp{{
		OpID:       "smuggle",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listA,
		Type:       "create",
		Changed:    map[string]any{"name": "Smuggled", "list": listB},
	}})
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}
	if rec, _ := app.FindRecordById(collectionItems, itemID); rec != nil {
		t.Errorf("record was created (list=%q); the op must not have been applied", rec.GetString("list"))
	}
}

// TestPush_Update_SmuggledListDenied: the same guard on the update path — a member
// cannot move an existing row of their own list into someone else's list.
func TestPush_Update_SmuggledListDenied(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	bob, _ := testutil.CreateAccount(t, app, "Bob")
	listA := testutil.CreateListFor(t, app, alice, "Test")
	listB := testutil.CreateListFor(t, app, bob, "Test")

	itemID := randid.ID()
	push(t, mux, tok, []pushOp{{
		OpID: "c", Collection: collectionItems, RecordID: itemID, ListID: listA,
		Type: "create", Changed: map[string]any{"name": "Milk"},
	}})

	results := push(t, mux, tok, []pushOp{{
		OpID: "move", Collection: collectionItems, RecordID: itemID, ListID: listA,
		Type:    "update",
		Changed: map[string]any{"list": listB},
		Base:    map[string]any{"list": listA},
	}})
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}
	rec, _ := app.FindRecordById(collectionItems, itemID)
	if rec.GetString("list") != listA {
		t.Errorf("list = %q, want %q (unmoved)", rec.GetString("list"), listA)
	}
}

// TestPush_ServerStampedFieldsDenied: checked_at / last_bought_at / deleted_at /
// modified_by are server-owned ([D-26], [D-45]) — an op carrying any of them is
// refused rather than silently trusted with the client's clock.
func TestPush_ServerStampedFieldsDenied(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, alice, "Test")

	for _, field := range []string{"checked_at", "last_bought_at", "deleted_at", "modified_by", "id", "updated", "created"} {
		itemID := randid.ID()
		results := push(t, mux, tok, []pushOp{{
			OpID: "stamp-" + field, Collection: collectionItems, RecordID: itemID, ListID: listID,
			Type:    "create",
			Changed: map[string]any{"name": "Milk", field: "1999-01-01 00:00:00.000Z"},
		}})
		if len(results) != 1 || results[0].Status != "denied" {
			t.Errorf("%s: status = %v, want denied", field, results)
		}
		if rec, _ := app.FindRecordById(collectionItems, itemID); rec != nil {
			t.Errorf("%s: record was created despite a server-owned field", field)
		}
	}
}

// TestPush_Category_SlugNotWritable: `slug` is copied by the §7.5 list-create
// transaction and keys the Others protection ([D-30]) — clients never write it.
func TestPush_Category_SlugNotWritable(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, alice, "Test")
	catID := seedOtherCategory(t, app, listID)

	results := push(t, mux, tok, []pushOp{{
		OpID: "reslug", Collection: collectionCategories, RecordID: catID, ListID: listID,
		Type:    "update",
		Changed: map[string]any{"slug": "produce"},
		Base:    map[string]any{"slug": "other"},
	}})
	if len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("status = %v, want denied", results)
	}
	rec, _ := app.FindRecordById(collectionCategories, catID)
	if rec.GetString("slug") != "other" {
		t.Errorf("slug = %q, want other (a renamed slug would escape the Others guard)", rec.GetString("slug"))
	}
}

// TestPush_Category_AllowedFieldsStillApply: the allowlist must not break the
// legitimate category edits of §6.7 (rename / re-emoji / recolor / reorder).
func TestPush_Category_AllowedFieldsStillApply(t *testing.T) {
	app, mux := setupSyncApp(t)
	alice, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, alice, "Test")
	catID := seedOtherCategory(t, app, listID)

	results := push(t, mux, tok, []pushOp{{
		OpID: "edit", Collection: collectionCategories, RecordID: catID, ListID: listID,
		Type:    "update",
		Changed: map[string]any{"name": "Sonstiges", "icon": "🧺", "color": "green", "sort_order": float64(3)},
		Base:    map[string]any{"name": nil, "icon": "folder", "color": "gray", "sort_order": float64(99)},
	}})
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("status = %v, want applied", results)
	}
	rec, _ := app.FindRecordById(collectionCategories, catID)
	if rec.GetString("name") != "Sonstiges" || rec.GetString("icon") != "🧺" || rec.GetInt("sort_order") != 3 {
		t.Errorf("category edit did not apply: name=%q icon=%q sort_order=%d",
			rec.GetString("name"), rec.GetString("icon"), rec.GetInt("sort_order"))
	}
}

// TestPush_NonBoolSignal_Denied: `deleted` and `checked` are the bool-typed
// writable fields; the push route reads them with type assertions that coerce
// a non-bool JSON value to false, and a coerced `deleted: "yes"` would read as
// a RESTORE — enough to lift a tombstone. Both deny as field_invalid before
// any coercion runs.
func TestPush_NonBoolSignal_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	// A tombstoned row: the smuggled non-bool "restore" must not lift it.
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
	opsDelete := []pushOp{{
		OpID:       "delete",
		Collection: collectionItems,
		RecordID:   itemID,
		ListID:     listID,
		Type:       "update",
		Changed:    map[string]any{"deleted": true},
	}}
	_ = push(t, mux, tok, opsDelete)

	ops := []pushOp{
		{
			OpID:       "bad-deleted",
			Collection: collectionItems,
			RecordID:   itemID,
			ListID:     listID,
			Type:       "update",
			Changed:    map[string]any{"deleted": "yes"},
		},
		{
			OpID:       "bad-checked",
			Collection: collectionItems,
			RecordID:   itemID,
			ListID:     listID,
			Type:       "update",
			Changed:    map[string]any{"checked": "true"},
		},
	}
	results := push(t, mux, tok, ops)
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}
	for _, r := range results {
		if r.Status != "denied" || r.Reason != reasonFieldInvalid {
			t.Errorf("status=%v reason=%v, want denied/%s", r.Status, r.Reason, reasonFieldInvalid)
		}
	}

	// The tombstone survived the smuggled restore.
	rec, _ := app.FindRecordById(collectionItems, itemID)
	if rec == nil || rec.GetString("deleted_at") == "" {
		t.Error("tombstone was lifted or lost by a non-bool deleted signal")
	}
}

// [D-266] The server stamps an item's photo from its barcode: the photo the
// lookup issued for that product, whatever image_url an op carries. A client
// from before still sends one; it is dropped, not refused, or its queued
// create would be lost.
func TestPush_PhotoFollowsTheBarcode(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	milk := testutil.SeedProductPhoto(t, app, "4000417025005")
	oats := testutil.SeedProductPhoto(t, app, "4006040000001")

	scanned, typed := randid.ID(), randid.ID()
	results := push(t, mux, tok, []pushOp{
		{OpID: "scanned", Collection: collectionItems, RecordID: scanned, ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Milch", "barcode": "4000417025005", "image_url": "https://tracker.example/pixel.gif"}},
		{OpID: "typed", Collection: collectionItems, RecordID: typed, ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Brot", "image_url": oats}},
	})
	for _, r := range results {
		if r.Status != "applied" {
			t.Fatalf("op %s: status=%v reason=%v, want applied", r.OpID, r.Status, r.Reason)
		}
	}
	photo := func(id string) string {
		rec, _ := app.FindRecordById(collectionItems, id)
		return rec.GetString("image_url")
	}
	if got := photo(scanned); got != milk {
		t.Errorf("scanned item's photo = %q, want its barcode's %q", got, milk)
	}
	if got := photo(typed); got != "" {
		t.Errorf("item without a barcode has photo %q, want none", got)
	}

	// A changed barcode brings its own photo; an op naming only a photo
	// changes nothing.
	results = push(t, mux, tok, []pushOp{
		{OpID: "rescan", Collection: collectionItems, RecordID: scanned, ListID: listID, Type: "update",
			Changed: map[string]any{"barcode": "4006040000001"}, Base: map[string]any{"barcode": "4000417025005"}},
		{OpID: "photo-only", Collection: collectionItems, RecordID: typed, ListID: listID, Type: "update",
			Changed: map[string]any{"image_url": milk}},
	})
	if results[0].Status != "applied" || results[1].Status != "noop" {
		t.Errorf("statuses = %v, %v; want applied, noop", results[0].Status, results[1].Status)
	}
	if got := photo(scanned); got != oats {
		t.Errorf("photo after the barcode changed = %q, want %q", got, oats)
	}
	if got := photo(typed); got != "" {
		t.Errorf("photo after a photo-only op = %q, want none", got)
	}
}

// TestPush_WrongTypedValue_Denied: every writable field has one JSON type, a
// string unless the field contract's `type` says otherwise. A number in a text field once passed every check, since the
// byte cap reads strings only: `name: 42` was stored with an empty name_norm,
// the key the duplicate merge folds by ([D-29]). A fractional sort_order was
// truncated. Each wrong type denies as field_invalid
// and writes nothing; null in a text field still clears it.
func TestPush_WrongTypedValue_Denied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	catID := seedOtherCategory(t, app, listID)

	cases := []struct {
		field      string
		collection string
		changed    map[string]any
	}{
		{"name", collectionItems, map[string]any{"name": 42}},
		{"note", collectionItems, map[string]any{"name": "Bread", "note": []any{"x"}}},
		{"quantity", collectionItems, map[string]any{"name": "Eggs", "quantity": map[string]any{"n": 2}}},
		{"name", collectionCategories, map[string]any{"name": 5}},
		{"sort_order", collectionCategories, map[string]any{"sort_order": "1"}},
		{"sort_order", collectionCategories, map[string]any{"sort_order": 1.5}},
	}
	for _, c := range cases {
		op := pushOp{OpID: c.collection + "-" + c.field, Collection: c.collection, ListID: listID, Changed: c.changed}
		if c.collection == collectionItems {
			op.Type, op.RecordID = "create", randid.ID()
		} else {
			op.Type, op.RecordID = "update", catID
		}
		r := push(t, mux, tok, []pushOp{op})[0]
		if r.Status != "denied" || r.Reason != reasonFieldInvalid || r.Field != c.field {
			t.Errorf("%s: status=%v reason=%v field=%v, want denied/%s/%s", op.OpID, r.Status, r.Reason, r.Field, reasonFieldInvalid, c.field)
		}
		if c.collection == collectionItems {
			if rec, _ := app.FindRecordById(collectionItems, op.RecordID); rec != nil {
				t.Errorf("%s: the item was created", op.OpID)
			}
		}
	}
	if cat, _ := app.FindRecordById(collectionCategories, catID); cat.GetString("name") != "" || cat.GetInt("sort_order") != 99 {
		t.Errorf("category changed: name=%q sort_order=%d", cat.GetString("name"), cat.GetInt("sort_order"))
	}

	// The types the app sends still apply: a number sort_order, null clearing
	// a text field.
	itemID := randid.ID()
	results := push(t, mux, tok, []pushOp{
		{OpID: "sort", Collection: collectionCategories, RecordID: catID, ListID: listID, Type: "update",
			Changed: map[string]any{"sort_order": 3}, Base: map[string]any{"sort_order": 99}},
		{OpID: "create", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Butter", "name_de": nil, "name_en": nil}},
	})
	for _, r := range results {
		if r.Status != "applied" {
			t.Errorf("op %s: status=%v reason=%v, want applied", r.OpID, r.Status, r.Reason)
		}
	}
}
