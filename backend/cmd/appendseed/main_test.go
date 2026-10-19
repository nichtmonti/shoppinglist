package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"shoppinglist/seed/candidates"
)

// liveProduce is a category file holding one live slug.
var liveProduce = map[string]bool{"produce": false}

// §6.13: "Appends only the entries whose id/slug isn't already present."
func TestPlanItemsSkipsExistingIDs(t *testing.T) {
	existing := map[string]bool{"item_cucumber": true}
	candidates := []candidates.Item{
		{NamesI18n: candidates.LocaleNames{En: []string{"cucumber"}, De: []string{"Gurke"}}, DefaultCategory: "produce"},
		{NamesI18n: candidates.LocaleNames{En: []string{"dragonfruit"}, De: []string{"Drachenfrucht"}}, DefaultCategory: "produce", Popularity: 1},
	}

	newItems, skipped, err := planItems(candidates, existing, liveProduce)
	if err != nil {
		t.Fatalf("planItems: %v", err)
	}
	if len(newItems) != 1 || newItems[0].ID != "item_dragonfruit" {
		t.Fatalf("expected only item_dragonfruit appended, got %+v", newItems)
	}
	if len(skipped) != 1 || skipped[0] != "item_cucumber" {
		t.Fatalf("expected item_cucumber skipped, got %+v", skipped)
	}
}

// A batch containing the same new name twice must not append it twice — the
// second occurrence is a duplicate within THIS batch, not just against the
// existing file.
func TestPlanItemsDedupesWithinBatch(t *testing.T) {
	candidates := []candidates.Item{
		{NamesI18n: candidates.LocaleNames{En: []string{"kiwi"}, De: []string{"Kiwi"}}, DefaultCategory: "produce"},
		{NamesI18n: candidates.LocaleNames{En: []string{"KIWI"}, De: []string{"Kiwi"}}, DefaultCategory: "produce"},
	}
	newItems, skipped, err := planItems(candidates, map[string]bool{}, liveProduce)
	if err != nil {
		t.Fatalf("planItems: %v", err)
	}
	if len(newItems) != 1 {
		t.Fatalf("expected exactly 1 new item (case-insensitive id collision), got %+v", newItems)
	}
	if len(skipped) != 1 {
		t.Fatalf("expected the second kiwi skipped, got %+v", skipped)
	}
}

func TestPlanItemsRejectsMissingEnName(t *testing.T) {
	_, _, err := planItems([]candidates.Item{{DefaultCategory: "produce"}}, map[string]bool{}, liveProduce)
	if err == nil {
		t.Fatal("expected an error for a candidate with no en name")
	}
}

func TestPlanItemsRejectsMissingDefaultCategory(t *testing.T) {
	_, _, err := planItems([]candidates.Item{
		{NamesI18n: candidates.LocaleNames{En: []string{"kiwi"}}},
	}, map[string]bool{}, liveProduce)
	if err == nil {
		t.Fatal("expected an error for a candidate with no default_category")
	}
}

// [D-300]: an item filed under an unknown or a retired category is refused,
// so no new item lands in an aisle no list offers.
func TestPlanItemsRejectsUnknownOrRetiredCategory(t *testing.T) {
	retiredBySlug := map[string]bool{"produce": false, "garden": true}
	for _, slug := range []string{"garden", "no_such_aisle"} {
		_, _, err := planItems([]candidates.Item{
			{NamesI18n: candidates.LocaleNames{En: []string{"basil plant"}}, DefaultCategory: slug},
		}, map[string]bool{}, retiredBySlug)
		if err == nil {
			t.Errorf("expected an error for default_category %q", slug)
		}
	}
}

func TestPlanCategoriesSkipsExistingSlugs(t *testing.T) {
	existing := map[string]bool{"produce": true}
	candidates := []candidates.Category{
		{Slug: "produce"},
		{Slug: "ready_meals", Icon: "🍱", Color: "orange", SortOrder: 18},
	}
	newCats, skipped, err := planCategories(candidates, existing)
	if err != nil {
		t.Fatalf("planCategories: %v", err)
	}
	if len(newCats) != 1 || newCats[0].Slug != "ready_meals" {
		t.Fatalf("expected only ready_meals appended, got %+v", newCats)
	}
	if len(skipped) != 1 || skipped[0] != "produce" {
		t.Fatalf("expected produce skipped, got %+v", skipped)
	}
}

func TestPlanCategoriesRejectsMissingSlug(t *testing.T) {
	_, _, err := planCategories([]candidates.Category{{Icon: "🍱"}}, map[string]bool{})
	if err == nil {
		t.Fatal("expected an error for a candidate with no slug")
	}
}

// appendJSONEntry must leave every existing byte untouched (§6.13: no full
// semantic re-read/re-write) and produce valid, appended JSON.
func TestAppendJSONEntryPreservesExistingBytesAndAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "items.json")
	original := "[\n  {\n    \"id\": \"item_cucumber\",\n    \"popularity\": 3\n  }\n]\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := appendJSONEntry(path, outputItem{
		ID:              "item_dragonfruit",
		NamesI18n:       candidates.LocaleNames{En: []string{"dragonfruit"}, De: []string{"Drachenfrucht"}},
		DefaultCategory: "produce",
		Popularity:      1,
	}); err != nil {
		t.Fatalf("appendJSONEntry: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	gotStr := string(got)

	// The original entry's bytes must survive completely unmodified.
	originalEntry := "  {\n    \"id\": \"item_cucumber\",\n    \"popularity\": 3\n  }"
	if !strings.Contains(gotStr, originalEntry) {
		t.Errorf("original entry bytes not preserved verbatim, got:\n%s", gotStr)
	}
	if !strings.Contains(gotStr, `"id": "item_dragonfruit"`) {
		t.Errorf("new entry not appended, got:\n%s", gotStr)
	}
	// en must come before de (fixed field order, not map alphabetization).
	if strings.Index(gotStr, `"en"`) > strings.Index(gotStr, `"de"`) {
		t.Errorf("expected en before de in the appended entry, got:\n%s", gotStr)
	}
	if !strings.HasSuffix(gotStr, "]\n") {
		t.Errorf("expected the file to still end with ']\\n', got suffix %q", gotStr[len(gotStr)-10:])
	}

	var parsed []map[string]any
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("result is not valid JSON: %v", err)
	}
	if len(parsed) != 2 {
		t.Errorf("expected 2 entries after append, got %d", len(parsed))
	}
}

func TestAppendJSONEntryHandlesEmptyArray(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(path, []byte("[\n]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := appendJSONEntry(path, candidates.Category{Slug: "produce"}); err != nil {
		t.Fatalf("appendJSONEntry on empty array: %v", err)
	}
	got, _ := os.ReadFile(path)
	var parsed []map[string]any
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%s", err, got)
	}
	if len(parsed) != 1 {
		t.Errorf("expected 1 entry, got %d", len(parsed))
	}
}

// bumpSeedVersion increments the constant and leaves the rest of the file untouched.
func TestBumpSeedVersionIncrements(t *testing.T) {
	dir := t.TempDir()
	origWD, _ := os.Getwd()
	defer func() { _ = os.Chdir(origWD) }()

	seedDir := filepath.Join(dir, "seed")
	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "package seed\n\n// comment\nconst CurrentSeedVersion = \"1\"\n\nfunc Version() string { return CurrentSeedVersion }\n"
	if err := os.WriteFile(filepath.Join(seedDir, "seed.go"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	next, err := bumpSeedVersion()
	if err != nil {
		t.Fatalf("bumpSeedVersion: %v", err)
	}
	if next != "2" {
		t.Errorf("next = %q, want %q", next, "2")
	}
	got, _ := os.ReadFile(filepath.Join(seedDir, "seed.go"))
	if !strings.Contains(string(got), `const CurrentSeedVersion = "2"`) {
		t.Errorf("seed.go not updated, got:\n%s", got)
	}
	if !strings.Contains(string(got), "// comment") {
		t.Errorf("unrelated content was disturbed, got:\n%s", got)
	}
}
