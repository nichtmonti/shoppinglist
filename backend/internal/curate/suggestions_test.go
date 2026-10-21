package curate

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
	"shoppinglist/seed"
	"shoppinglist/seed/candidates"
)

func mustCollection(t *testing.T, app core.App, name string) *core.Collection {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		t.Fatalf("find %s collection: %v", name, err)
	}
	return col
}

func makeList(t *testing.T, app core.App) string {
	t.Helper()
	rec := core.NewRecord(mustCollection(t, app, "lists"))
	rec.Id = randid.ID()
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save list: %v", err)
	}
	return rec.Id
}

func makeCategory(t *testing.T, app core.App, listID, slug string) string {
	t.Helper()
	rec := core.NewRecord(mustCollection(t, app, "list_categories"))
	rec.Id = randid.ID()
	rec.Set("list", listID)
	rec.Set("slug", slug)
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save list_categories: %v", err)
	}
	return rec.Id
}

func makeItem(t *testing.T, app core.App, listID, name, categoryKey string, deleted bool) {
	t.Helper()
	rec := core.NewRecord(mustCollection(t, app, "items"))
	rec.Id = randid.ID()
	rec.Set("list", listID)
	rec.Set("name", name)
	rec.Set("category_key", categoryKey)
	if deleted {
		rec.Set("deleted_at", "2026-01-01 00:00:00.000Z")
	}
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatalf("save item: %v", err)
	}
}

func setupApp(t *testing.T) core.App {
	t.Helper()
	app := testutil.NewApp(t)
	if err := seed.Run(app); err != nil {
		t.Fatalf("seed.Run: %v", err)
	}
	return app
}

// §6.13's core exclusion: a name already in item_dictionary (any locale, any
// synonym) is never suggested, no matter how many lists it appears on.
func TestSuggestionsExcludesDictionaryMatches(t *testing.T) {
	app := setupApp(t)
	list := makeList(t, app)
	produce := makeCategory(t, app, list, "produce")

	// "Gurke" is item_dictionary's seeded German synonym for item_cucumber
	// (backend/seed/items.json) — a case-different match must still exclude it.
	for range 5 {
		makeItem(t, app, makeList(t, app), "GURKE", produce, false)
	}

	groups, err := Suggestions(app, 1)
	if err != nil {
		t.Fatalf("Suggestions: %v", err)
	}
	for _, g := range groups {
		if g.Name == "gurke" {
			t.Fatalf("expected 'gurke' excluded as a known dictionary name, got group %+v", g)
		}
	}
}

func TestSuggestionsGroupsByNormalizedNameAndCountsDistinctLists(t *testing.T) {
	app := setupApp(t)
	listA := makeList(t, app)
	listB := makeList(t, app)
	listC := makeList(t, app)
	catA := makeCategory(t, app, listA, "produce")
	catB := makeCategory(t, app, listB, "snacks_sweets")

	// Same normalized name via case + whitespace variants, across 3 distinct
	// lists. "dragonfruit" (unlike the spec's own "kiwi" example) is not in the
	// seed dictionary, so it is not excluded by the dictionary check.
	makeItem(t, app, listA, "Dragonfruit", catA, false)
	makeItem(t, app, listB, "  dragonfruit ", catB, false)
	makeItem(t, app, listC, "DRAGONFRUIT", "", false) // no category_key -> "none"
	// A second item on listA must not double-count listA's distinct-list membership.
	makeItem(t, app, listA, "dragonfruit", catA, false)

	groups, err := Suggestions(app, 3)
	if err != nil {
		t.Fatalf("Suggestions: %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("expected exactly 1 group at min-lists=3, got %d: %+v", len(groups), groups)
	}
	g := groups[0]
	if g.Name != "dragonfruit" {
		t.Errorf("Name = %q, want %q", g.Name, "dragonfruit")
	}
	if g.ListCount != 3 {
		t.Errorf("ListCount = %d, want 3 (distinct lists, not occurrences)", g.ListCount)
	}
	if g.CategoryCount["produce"] != 2 {
		t.Errorf("CategoryCount[produce] = %d, want 2", g.CategoryCount["produce"])
	}
	if g.CategoryCount["none"] != 1 {
		t.Errorf("CategoryCount[none] = %d, want 1 (no category_key)", g.CategoryCount["none"])
	}
}

// Groups below the threshold are dropped — the one-off-typo filter.
func TestSuggestionsDropsGroupsBelowMinLists(t *testing.T) {
	app := setupApp(t)
	makeItem(t, app, makeList(t, app), "Hummus", "", false)
	makeItem(t, app, makeList(t, app), "Hummus", "", false)

	groups, err := Suggestions(app, 3)
	if err != nil {
		t.Fatalf("Suggestions: %v", err)
	}
	for _, g := range groups {
		if g.Name == "hummus" {
			t.Fatalf("expected 'hummus' dropped below min-lists=3 (seen on 2), got %+v", g)
		}
	}
}

// A tombstoned item is not live vocabulary and must not seed a suggestion.
func TestSuggestionsIgnoresTombstonedItems(t *testing.T) {
	app := setupApp(t)
	for range 5 {
		makeItem(t, app, makeList(t, app), "Mango", "", true)
	}

	groups, err := Suggestions(app, 1)
	if err != nil {
		t.Fatalf("Suggestions: %v", err)
	}
	for _, g := range groups {
		if g.Name == "mango" {
			t.Fatalf("expected tombstoned 'mango' rows excluded, got %+v", g)
		}
	}
}

// A category_key pointing at a row with no slug (a per-list custom category)
// is labelled "custom", distinct from "none" (no category_key at all, §6.13).
func TestSuggestionsLabelsCustomCategoryDistinctFromNone(t *testing.T) {
	app := setupApp(t)
	list := makeList(t, app)
	custom := makeCategory(t, app, list, "") // slug-less: an operator-renamed/custom row

	for range 3 {
		makeItem(t, app, makeList(t, app), "Ready Meal", custom, false)
	}

	groups, err := Suggestions(app, 3)
	if err != nil {
		t.Fatalf("Suggestions: %v", err)
	}
	if len(groups) != 1 || groups[0].Name != "ready meal" {
		t.Fatalf("expected exactly one 'ready meal' group, got %+v", groups)
	}
	if got := groups[0].CategoryCount["custom"]; got != 3 {
		t.Errorf("CategoryCount[custom] = %d, want 3", got)
	}
}

// Groups sort by list-count descending, per §6.13's printed format. The names
// must stay out of the seed dictionary, which Suggestions skips.
func TestSuggestionsSortsByListCountDescending(t *testing.T) {
	app := setupApp(t)
	for range 3 {
		makeItem(t, app, makeList(t, app), "Rambutan", "", false)
	}
	for range 5 {
		makeItem(t, app, makeList(t, app), "Salak", "", false)
	}

	groups, err := Suggestions(app, 1)
	if err != nil {
		t.Fatalf("Suggestions: %v", err)
	}
	if len(groups) < 2 || groups[0].Name != "salak" || groups[0].ListCount != 5 {
		t.Fatalf("expected salak (5 lists) first, got %+v", groups)
	}
}

func TestPrintFormatsPerSpec(t *testing.T) {
	groups := []Group{
		{Name: "kiwi", ListCount: 5, CategoryCount: map[string]int{"produce": 4, "snacks_sweets": 1}},
	}
	var buf bytes.Buffer
	Print(&buf, groups)
	out := buf.String()
	if !strings.Contains(out, `"kiwi"`) || !strings.Contains(out, "(5 lists)") {
		t.Errorf("Print output missing name/list-count: %q", out)
	}
	if !strings.Contains(out, "produce: 4") || !strings.Contains(out, "snacks_sweets: 1") {
		t.Errorf("Print output missing category counts: %q", out)
	}
	// Higher count first within a group's category breakdown.
	if strings.Index(out, "produce: 4") > strings.Index(out, "snacks_sweets: 1") {
		t.Errorf("expected produce:4 before snacks_sweets:1 (descending), got %q", out)
	}
}

// The emitted document decodes as the seed/candidates shape cmd/appendseed
// reads, with each group resolved to its top known category.
func TestEmitJSONRoundTripsThroughAppendseedShape(t *testing.T) {
	groups := []Group{
		// Mixed votes: produce wins 2:1.
		{Name: "dragonfruit", RawName: "Dragonfruit", ListCount: 3, CategoryCount: map[string]int{"produce": 2, "snacks_sweets": 1}},
		// 1:1 tie: alphabetically smaller slug wins.
		{Name: "papaya", RawName: "Papaya", ListCount: 2, CategoryCount: map[string]int{"snacks_sweets": 1, "produce": 1}},
		// Only non-resolvable labels: dropped entirely (appendseed would
		// hard-error on an empty default_category).
		{Name: "hummus", RawName: "Hummus", ListCount: 2, CategoryCount: map[string]int{customLabel: 2}},
		// A retired slug ([D-300]) never wins, however many votes it has.
		{Name: "basil plant", RawName: "Basil plant", ListCount: 4, CategoryCount: map[string]int{"garden": 3, "produce": 1}},
		// Only a retired slug: dropped like the custom-only group.
		{Name: "fern", RawName: "Fern", ListCount: 3, CategoryCount: map[string]int{"garden": 3}},
	}
	live, err := liveSlugs(setupApp(t))
	if err != nil {
		t.Fatalf("liveSlugs: %v", err)
	}
	var buf bytes.Buffer
	if err := EmitJSON(&buf, groups, live); err != nil {
		t.Fatalf("EmitJSON: %v", err)
	}

	var doc candidates.File
	if err := json.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatalf("emitted JSON does not parse as appendseed candidates: %v\n%s", err, buf.String())
	}
	if len(doc.Items) != 3 {
		t.Fatalf("want 3 emitted items (custom-only and retired-only groups dropped), got %d: %s", len(doc.Items), buf.String())
	}
	if len(doc.Categories) != 0 {
		t.Errorf("want no categories emitted, got %d", len(doc.Categories))
	}
	byName := map[string]string{}
	for _, it := range doc.Items {
		byName[it.NamesI18n.En[0]] = it.DefaultCategory
	}
	if len(byName) != 3 {
		t.Fatalf("want 3 distinct candidates, got %d: %s", len(byName), buf.String())
	}
	if byName["Basil plant"] != "produce" {
		t.Errorf("a retired slug must lose to a live one, got %q: %s", byName["Basil plant"], buf.String())
	}
	if byName["Dragonfruit"] != "produce" {
		t.Errorf("mixed-vote group should resolve to produce (2:1), got %q: %s", byName["Dragonfruit"], buf.String())
	}
	if byName["Papaya"] != "produce" {
		t.Errorf("1:1 tie should resolve to the alphabetically smaller slug (produce < snacks_sweets), got %q: %s", byName["Papaya"], buf.String())
	}
	if _, ok := byName["Hummus"]; ok {
		t.Errorf("custom-only group must be dropped entirely (appendseed would hard-error): %s", buf.String())
	}
}
