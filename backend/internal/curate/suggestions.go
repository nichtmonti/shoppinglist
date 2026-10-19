// Package curate implements the read-only half of the §6.13 operator
// content-curation tooling: `./shoppinglist dictionary-suggestions`. It never
// writes item_dictionary; it surfaces candidates for the operator to review
// and feed into cmd/appendseed, the write half.
//
// It is a CLI subcommand, not an HTTP route, because its only caller already
// has shell access to the box ([D-34]).
package curate

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"

	"shoppinglist/internal/normalize"
	"shoppinglist/seed/candidates"
)

// DefaultMinLists is §6.13's suggested threshold ("e.g. 3 distinct lists") for
// filtering out one-off typos.
const DefaultMinLists = 3

// unmappedLabel / customLabel are printed instead of a slug when a group's
// category_key does not resolve to a category_templates slug (§6.13).
const (
	unmappedLabel = "none"   // category_key is null, or points at a row that no longer exists
	customLabel   = "custom" // category_key resolves to a list_categories row with no slug (a per-list custom category)
)

// Group is one candidate: a normalized name not in the dictionary, its
// distinct-list count, and its occurrence count per category label. RawName,
// the most common raw spelling behind Name, is used only by --json.
type Group struct {
	Name          string
	RawName       string
	ListCount     int
	CategoryCount map[string]int
}

// Suggestions groups every non-deleted item whose normalized name has no match
// in item_dictionary by that name, and drops groups seen on fewer than
// minLists distinct lists. It uses the app's real normalization, never a
// re-implementation (§6.13, [D-44]). Read-only.
func Suggestions(app core.App, minLists int) ([]Group, error) {
	known, err := knownNames(app)
	if err != nil {
		return nil, fmt.Errorf("load item_dictionary: %w", err)
	}

	categoryLabels, err := categoryLabelsByID(app)
	if err != nil {
		return nil, fmt.Errorf("load list_categories: %w", err)
	}

	// Tombstoned rows are not live vocabulary.
	items, err := app.FindRecordsByFilter("items", "deleted_at = ''", "", 0, 0)
	if err != nil {
		return nil, fmt.Errorf("load items: %w", err)
	}

	type accum struct {
		lists      map[string]struct{}
		categories map[string]int
		raw        map[string]int // raw spellings -> occurrence count, for the --json name winner
	}
	byName := map[string]*accum{}

	for _, item := range items {
		name := normalize.Name(item.GetString("name"))
		if name == "" || known[name] {
			continue
		}
		a := byName[name]
		if a == nil {
			a = &accum{lists: map[string]struct{}{}, categories: map[string]int{}, raw: map[string]int{}}
			byName[name] = a
		}
		a.lists[item.GetString("list")] = struct{}{}
		a.categories[categoryLabel(item.GetString("category_key"), categoryLabels)]++
		if raw := strings.TrimSpace(item.GetString("name")); raw != "" {
			a.raw[raw]++
		}
	}

	groups := make([]Group, 0, len(byName))
	for name, a := range byName {
		if len(a.lists) < minLists {
			continue
		}
		// The raw spelling typed most often: --json emits it as appendseed's
		// canonical en name.
		raw, _ := argmax(a.raw, func(string) bool { return true })
		groups = append(groups, Group{
			Name:          name,
			RawName:       raw,
			ListCount:     len(a.lists),
			CategoryCount: a.categories,
		})
	}

	// List count descending (§6.13), name ascending for stable ties.
	slices.SortFunc(groups, func(a, b Group) int { return byCountThenKey(a.ListCount, a.Name, b.ListCount, b.Name) })
	return groups, nil
}

// byCountThenKey orders by count descending, then key ascending: the report's
// order, and argmax's tie rule.
func byCountThenKey(an int, ak string, bn int, bk string) int {
	return cmp.Or(cmp.Compare(bn, an), strings.Compare(ak, bk))
}

// argmax returns the key with the highest count among those keep accepts,
// ties going to the smaller key; false when keep accepts none.
func argmax(counts map[string]int, keep func(string) bool) (best string, found bool) {
	bestN := 0
	for k, n := range counts {
		if keep(k) && (!found || byCountThenKey(n, k, bestN, best) < 0) {
			best, bestN, found = k, n, true
		}
	}
	return best, found
}

// knownNames returns every normalized name in item_dictionary, all locales and
// synonyms (§6.12), as a set.
func knownNames(app core.App) (map[string]bool, error) {
	rows, err := app.FindAllRecords("item_dictionary")
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for _, row := range rows {
		var namesI18n map[string][]string
		if err := row.UnmarshalJSONField("names_i18n", &namesI18n); err != nil {
			continue // malformed row — skip rather than abort the whole scan
		}
		for _, names := range namesI18n {
			for _, n := range names {
				known[normalize.Name(n)] = true
			}
		}
	}
	return known, nil
}

// categoryLabelsByID maps every list_categories row id to its label: the
// template slug if it has one, customLabel otherwise (§6.13).
func categoryLabelsByID(app core.App) (map[string]string, error) {
	rows, err := app.FindAllRecords("list_categories")
	if err != nil {
		return nil, err
	}
	labels := make(map[string]string, len(rows))
	for _, row := range rows {
		slug := row.GetString("slug")
		if slug == "" {
			slug = customLabel
		}
		labels[row.Id] = slug
	}
	return labels, nil
}

// liveSlugs is every category template slug not retired ([D-300]), the
// default_category values cmd/appendseed accepts.
func liveSlugs(app core.App) (map[string]bool, error) {
	rows, err := app.FindRecordsByFilter("category_templates", "retired = false", "", 0, 0)
	if err != nil {
		return nil, err
	}
	live := make(map[string]bool, len(rows))
	for _, row := range rows {
		live[row.GetString("slug")] = true
	}
	return live, nil
}

// categoryLabel resolves an item's category_key (§6.6: a plain key into the
// list's own list_categories rows, not a relation) to a printable label.
func categoryLabel(categoryKey string, labels map[string]string) string {
	if categoryKey == "" {
		return unmappedLabel
	}
	if label, ok := labels[categoryKey]; ok {
		return label
	}
	return unmappedLabel // dangling category_key — the row no longer exists
}

// Print writes the §6.13 report format, e.g.:
//
//	"kiwi"     (5 lists)  produce: 4, snacks_sweets: 1
//	"hummus"   (4 lists)  pantry: 2, dairy_eggs: 1, other: 1
func Print(w io.Writer, groups []Group) {
	for _, g := range groups {
		fmt.Fprintf(w, "%-12s (%d lists)  %s\n", fmt.Sprintf("%q", g.Name), g.ListCount, formatCategories(g.CategoryCount))
	}
}

func formatCategories(counts map[string]int) string {
	labels := slices.SortedFunc(maps.Keys(counts), func(a, b string) int {
		return byCountThenKey(counts[a], a, counts[b], b)
	})
	parts := make([]string, len(labels))
	for i, label := range labels {
		parts[i] = fmt.Sprintf("%s: %d", label, counts[label])
	}
	return strings.Join(parts, ", ")
}

// EmitJSON writes the candidates document cmd/appendseed consumes
// (seed/candidates) to w as indented JSON. Each group becomes one item: its
// most common raw spelling as names_i18n.en[0] and its top-voted slug in live
// as default_category. Groups with no live slug are dropped, because
// appendseed refuses any other default_category.
func EmitJSON(w io.Writer, groups []Group, live map[string]bool) error {
	// No new categories are ever proposed. Popularity stays 0 for the
	// operator to set during review.
	doc := candidates.File{
		Items:      []candidates.Item{},
		Categories: []candidates.Category{},
	}
	for _, g := range groups {
		// The top-voted live slug, which leaves out unmappedLabel, customLabel
		// and a retired slug ([D-300]).
		slug, ok := argmax(g.CategoryCount, func(label string) bool { return live[label] })
		if !ok {
			continue // no live category — appendseed would reject the item
		}
		en := g.RawName
		if en == "" {
			en = g.Name // defensive: a Group not built by Suggestions still yields a valid name
		}
		doc.Items = append(doc.Items, candidates.Item{
			NamesI18n:       candidates.LocaleNames{En: []string{en}},
			DefaultCategory: slug,
		})
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(doc)
}

// NewCommand builds the `dictionary-suggestions` subcommand (§6.13). It needs
// a data directory served at least once, since only `serve` runs migrations.
func NewCommand(app core.App) *cobra.Command {
	minLists := DefaultMinLists
	asJSON := false
	cmd := &cobra.Command{
		Use:   "dictionary-suggestions",
		Short: "Print usage-derived item_dictionary candidates (read-only, §6.13)",
		Long: "Scans non-deleted items across all lists for names with no match in " +
			"item_dictionary, groups them by normalized name, and prints those seen on " +
			"enough distinct lists to be worth curating. Purely additive and read-only " +
			"— it never writes item_dictionary. Feed accepted rows into cmd/appendseed " +
			"(--json emits exactly its candidates schema, closing the loop).\n\n" +
			"Requires a data directory that has already been served at least once " +
			"(migrations run as part of `serve`, not this command).",
		RunE: func(command *cobra.Command, _ []string) error {
			groups, err := Suggestions(app, minLists)
			if err != nil {
				return err
			}
			if asJSON {
				live, err := liveSlugs(app)
				if err != nil {
					return fmt.Errorf("load category_templates: %w", err)
				}
				return EmitJSON(command.OutOrStdout(), groups, live)
			}
			Print(command.OutOrStdout(), groups)
			return nil
		},
	}
	cmd.Flags().IntVar(&minLists, "min-lists", DefaultMinLists,
		"drop groups seen on fewer than this many distinct lists")
	cmd.Flags().BoolVar(&asJSON, "json", false,
		"emit cmd/appendseed's candidates JSON instead of the human format")
	return cmd
}
