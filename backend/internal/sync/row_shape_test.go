package sync

import (
	"sort"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/fieldcontract"
)

// TestRecordMapKeysMatchContract pins the canonical client-facing row columns
// (itemRecordMap / categoryRecordMap) to the shared contract's row_shape, the
// single source both sides read.
func TestRecordMapKeysMatchContract(t *testing.T) {
	app, _ := setupSyncApp(t)

	itemsCol, err := app.FindCollectionByNameOrId(collectionItems)
	if err != nil {
		t.Fatalf("find items collection: %v", err)
	}
	catCol, err := app.FindCollectionByNameOrId(collectionCategories)
	if err != nil {
		t.Fatalf("find list_categories collection: %v", err)
	}

	itemKeys := sortedMapKeys(itemRecordMap(core.NewRecord(itemsCol)))
	catKeys := sortedMapKeys(categoryRecordMap(core.NewRecord(catCol)))

	itemShape, itemOK := fieldcontract.RowShape("items")
	catShape, catOK := fieldcontract.RowShape("list_categories")
	assertRowShape(t, "items", itemKeys, itemShape, itemOK)
	assertRowShape(t, "list_categories", catKeys, catShape, catOK)
}

func sortedMapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func assertRowShape(t *testing.T, collection string, got []string, want []string, ok bool) {
	t.Helper()
	if !ok {
		t.Fatalf("contract has no row_shape for %s", collection)
	}
	gotSet := make(map[string]bool, len(got))
	for _, k := range got {
		gotSet[k] = true
	}
	wantSet := make(map[string]bool, len(want))
	for _, k := range want {
		wantSet[k] = true
	}
	// Set equality, both directions.
	for k := range gotSet {
		if !wantSet[k] {
			t.Errorf("%s: record map key %q is not in the contract", collection, k)
		}
	}
	for k := range wantSet {
		if !gotSet[k] {
			t.Errorf("%s: contract key %q is missing from the record map", collection, k)
		}
	}
}
