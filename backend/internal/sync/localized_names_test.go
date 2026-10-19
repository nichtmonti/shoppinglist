package sync

import (
	"strings"
	"testing"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// [D-21]: a scanned item carries its localized names as two ordinary text
// columns, so the push route's per-field merge handles them like any other.
// A rename sends name plus both localized names cleared, in one op — and that
// op must APPLY, not settle as partial: a partial here would leave the old
// scanned name showing to every member after the rename.
func TestPush_LocalizedNames_CreateThenRenameClears(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")
	itemID := randid.ID()

	created := push(t, mux, tok, []pushOp{{
		OpID: "create", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "create",
		Changed: map[string]any{"name": "Pâte à tartiner", "name_de": "Nuss-Nougat-Creme", "name_en": "Hazelnut spread"},
	}})
	if len(created) != 1 || created[0].Status != "applied" {
		t.Fatalf("create = %+v, want applied", created)
	}
	if created[0].Record["name_de"] != "Nuss-Nougat-Creme" || created[0].Record["name_en"] != "Hazelnut spread" {
		t.Fatalf("created record = %v, want both localized names", created[0].Record)
	}

	renamed := push(t, mux, tok, []pushOp{{
		OpID: "rename", Collection: collectionItems, RecordID: itemID, ListID: listID, Type: "update",
		Changed: map[string]any{"name": "Nutella", "name_de": nil, "name_en": nil},
		Base:    map[string]any{"name": "Pâte à tartiner", "name_de": "Nuss-Nougat-Creme", "name_en": "Hazelnut spread"},
	}})
	if len(renamed) != 1 || renamed[0].Status != "applied" {
		t.Fatalf("rename = %+v, want applied", renamed)
	}
	rec := renamed[0].Record
	if rec["name"] != "Nutella" || rec["name_de"] != nil || rec["name_en"] != nil {
		t.Errorf("renamed record = name %v, name_de %v, name_en %v; want Nutella and both cleared",
			rec["name"], rec["name_de"], rec["name_en"])
	}
}

// Each localized name has the same cap as name itself.
func TestPush_LocalizedNames_OverCapDenied(t *testing.T) {
	app, mux := setupSyncApp(t)
	acctID, tok := testutil.CreateAccount(t, app, "Alice")
	listID := testutil.CreateListFor(t, app, acctID, "Test")

	for _, field := range []string{"name_de", "name_en"} {
		res := push(t, mux, tok, []pushOp{{
			OpID: field, Collection: collectionItems, RecordID: randid.ID(), ListID: listID, Type: "create",
			Changed: map[string]any{"name": "Milch", field: strings.Repeat("x", 257)},
		}})
		if len(res) != 1 || res[0].Status != "denied" || res[0].Field != field {
			t.Errorf("%s over cap = %+v, want denied on that field", field, res)
		}
	}
}
