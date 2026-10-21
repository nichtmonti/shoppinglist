// Command appendseed is the §6.13 additive seed-append script: the write half
// of the operator content-curation tooling, outside the shipped binary. It
// edits only the checked-in seed files (seed/items.json, seed/categories.json,
// seed/seed.go), never a running database.
//
// Usage, from backend/:
//
//	go run ./cmd/appendseed -candidates candidates.json
//
// The candidates file (seed/candidates) holds new items and/or categories in
// the seed files' own shape, minus the item id, which seed.ItemID derives.
// A restart then applies them: the boot seeder (§6.12) upserts on the bumped
// seed_version, and clients re-mirror on the version change.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"shoppinglist/seed"
	"shoppinglist/seed/candidates"
)

// outputItem is candidates.Item plus the derived id, in the file's field order.
type outputItem struct {
	ID              string                 `json:"id"`
	NamesI18n       candidates.LocaleNames `json:"names_i18n"`
	DefaultCategory string                 `json:"default_category"`
	Popularity      int                    `json:"popularity"`
}

// existingItem / existingCategory read only the id/slug of every existing seed
// row (§6.13), and whether a category is retired ([D-300]).
type existingItem struct {
	ID string `json:"id"`
}
type existingCategory struct {
	Slug    string `json:"slug"`
	Retired bool   `json:"retired"`
}

const (
	itemsPath      = "seed/items.json"
	categoriesPath = "seed/categories.json"
	seedGoPath     = "seed/seed.go"
)

func main() {
	candidatesPath := flag.String("candidates", "", "path to a candidates JSON file (see cmd/appendseed's doc comment for the shape)")
	flag.Parse()
	if *candidatesPath == "" {
		fmt.Fprintln(os.Stderr, "usage: go run ./cmd/appendseed -candidates candidates.json")
		os.Exit(2)
	}

	if err := run(*candidatesPath); err != nil {
		fmt.Fprintln(os.Stderr, "appendseed:", err)
		os.Exit(1)
	}
}

func run(candidatesPath string) error {
	var doc candidates.File
	// #nosec G304 -- the path IS the operator's argv: dev-time seed-editing CLI, not shipped (see .goreleaser.yaml).
	raw, err := os.ReadFile(candidatesPath)
	if err != nil {
		return fmt.Errorf("read candidates file: %w", err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("parse candidates file: %w", err)
	}
	if len(doc.Items) == 0 && len(doc.Categories) == 0 {
		return errors.New("candidates file has no items and no categories — nothing to do")
	}

	existingItemIDs, err := existingIDs()
	if err != nil {
		return err
	}
	retiredBySlug, err := existingSlugs()
	if err != nil {
		return err
	}

	// Build the whole plan before writing anything, so a bad candidate aborts
	// with no file edited. The writes themselves are not transactional: one
	// that fails part-way leaves the earlier files edited, for the operator to
	// revert with git.
	newCategories, skippedCategories, err := planCategories(doc.Categories, retiredBySlug)
	if err != nil {
		return err
	}
	for _, c := range newCategories {
		retiredBySlug[c.Slug] = false // an item may file under a category of the same batch
	}
	newItems, skippedItems, err := planItems(doc.Items, existingItemIDs, retiredBySlug)
	if err != nil {
		return err
	}

	for _, it := range newItems {
		if err := appendJSONEntry(itemsPath, it); err != nil {
			return fmt.Errorf("append to %s: %w", itemsPath, err)
		}
	}
	for _, cat := range newCategories {
		if err := appendJSONEntry(categoriesPath, cat); err != nil {
			return fmt.Errorf("append to %s: %w", categoriesPath, err)
		}
	}

	if len(newItems) > 0 || len(newCategories) > 0 {
		newVersion, err := bumpSeedVersion()
		if err != nil {
			return fmt.Errorf("bump seed_version: %w", err)
		}
		fmt.Printf("seed_version bumped to %q\n", newVersion)
	}

	fmt.Printf("items: %d appended, %d skipped (already present)\n", len(newItems), len(skippedItems))
	for _, id := range skippedItems {
		fmt.Printf("  skipped (already present): %s\n", id)
	}
	fmt.Printf("categories: %d appended, %d skipped (already present)\n", len(newCategories), len(skippedCategories))
	for _, slug := range skippedCategories {
		fmt.Printf("  skipped (already present): %s\n", slug)
	}
	if len(newItems) > 0 || len(newCategories) > 0 {
		fmt.Println("Rebuild and redeploy the binary to apply: the seed is embedded, and the boot seeder upserts on the bumped seed_version.")
	}
	return nil
}

func existingIDs() (map[string]bool, error) {
	raw, err := os.ReadFile(itemsPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", itemsPath, err)
	}
	var rows []existingItem
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("parse %s: %w", itemsPath, err)
	}
	ids := make(map[string]bool, len(rows))
	for _, r := range rows {
		ids[r.ID] = true
	}
	return ids, nil
}

// existingSlugs maps every existing category slug to whether it is retired.
func existingSlugs() (map[string]bool, error) {
	raw, err := os.ReadFile(categoriesPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", categoriesPath, err)
	}
	var rows []existingCategory
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("parse %s: %w", categoriesPath, err)
	}
	slugs := make(map[string]bool, len(rows))
	for _, r := range rows {
		slugs[r.Slug] = r.Retired
	}
	return slugs, nil
}

// planItems refuses an item filed under a category that does not exist or is
// retired ([D-300]): new items would land in an aisle no list offers.
func planItems(proposed []candidates.Item, existingIDs, retiredBySlug map[string]bool) (newItems []outputItem, skipped []string, err error) {
	seenThisBatch := map[string]bool{}
	for _, c := range proposed {
		en := ""
		if len(c.NamesI18n.En) > 0 {
			en = c.NamesI18n.En[0]
		}
		if en == "" {
			return nil, nil, fmt.Errorf("candidate item missing names_i18n.en[0] (canonical en name): %+v", c)
		}
		if retired, ok := retiredBySlug[c.DefaultCategory]; !ok || retired {
			return nil, nil, fmt.Errorf("candidate item %q: default_category %q is not a live category", en, c.DefaultCategory)
		}
		id := seed.ItemID(en)
		if existingIDs[id] || seenThisBatch[id] {
			skipped = append(skipped, id)
			continue
		}
		seenThisBatch[id] = true
		newItems = append(newItems, outputItem{
			ID:              id,
			NamesI18n:       c.NamesI18n,
			DefaultCategory: c.DefaultCategory,
			Popularity:      c.Popularity,
		})
	}
	return newItems, skipped, nil
}

func planCategories(proposed []candidates.Category, existingSlugs map[string]bool) (newCategories []candidates.Category, skipped []string, err error) {
	seenThisBatch := map[string]bool{}
	for _, c := range proposed {
		if c.Slug == "" {
			return nil, nil, fmt.Errorf("candidate category missing slug: %+v", c)
		}
		if _, ok := existingSlugs[c.Slug]; ok || seenThisBatch[c.Slug] {
			skipped = append(skipped, c.Slug)
			continue
		}
		seenThisBatch[c.Slug] = true
		newCategories = append(newCategories, c)
	}
	return newCategories, skipped, nil
}

// appendJSONEntry splices one entry onto the end of a top-level JSON array
// file by text, not a marshal round-trip, so existing entries' bytes
// (seed/categories.json's hand-aligned columns included) stay untouched.
func appendJSONEntry(path string, entry any) error {
	// #nosec G304 -- same argv-fed dev tool as run(); path is the caller's argument, not attacker input.
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	entryJSON, err := json.MarshalIndent(entry, "  ", "  ")
	if err != nil {
		return err
	}
	// MarshalIndent's first line carries no prefix.
	entryText := "  " + string(entryJSON)

	content := strings.TrimRight(string(raw), "\n")
	if !strings.HasSuffix(content, "]") {
		return fmt.Errorf("%s does not end with ']' — refusing to guess where the array closes", path)
	}
	body := strings.TrimRight(strings.TrimSuffix(content, "]"), " \t\n")

	var newContent string
	if strings.HasSuffix(body, "[") {
		newContent = body + "\n" + entryText + "\n]\n" // was an empty array
	} else {
		newContent = body + ",\n" + entryText + "\n]\n"
	}
	// #nosec G703 G306 -- operator-invoked dev tool: the path is the argument, and the seed files are
	// committed (0644 matches every other checked-in file; 0600 would break the shared-worktree flow).
	return os.WriteFile(path, []byte(newContent), 0o644)
}

var seedVersionRe = regexp.MustCompile(`(const CurrentSeedVersion = ")(\d+)(")`)

// bumpSeedVersion increments the integer in seed/seed.go's
// `const CurrentSeedVersion = "N"` line by one and returns the new value.
func bumpSeedVersion() (string, error) {
	raw, err := os.ReadFile(seedGoPath)
	if err != nil {
		return "", err
	}
	match := seedVersionRe.FindSubmatch(raw)
	if match == nil {
		return "", fmt.Errorf("%s: CurrentSeedVersion constant not found in the expected form", seedGoPath)
	}
	n, err := strconv.Atoi(string(match[2]))
	if err != nil {
		return "", fmt.Errorf("%s: CurrentSeedVersion is not an integer: %w", seedGoPath, err)
	}
	next := strconv.Itoa(n + 1)
	updated := seedVersionRe.ReplaceAll(raw, []byte("${1}"+next+"${3}"))
	// #nosec G703 G306 -- same operator-invoked tool: writes seed/seed.go in place, 0644 like the original.
	if err := os.WriteFile(seedGoPath, updated, 0o644); err != nil {
		return "", err
	}
	return next, nil
}
