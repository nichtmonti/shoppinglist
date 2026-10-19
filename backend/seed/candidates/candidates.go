// Package candidates is the §6.13 candidates document: the new seed entries
// the dictionary-suggestions subcommand proposes (internal/curate, --json) and
// cmd/appendseed appends to the checked-in seed files. One definition keeps
// the writer and the reader of the file in step.
//
// The shape is the seed files' own, minus an item's id: appendseed derives
// that the way the boot seeder does (seed.ItemID).
package candidates

// File is the whole candidates document.
type File struct {
	Items      []Item     `json:"items"`
	Categories []Category `json:"categories"`
}

// Item is a proposed item_dictionary entry.
type Item struct {
	NamesI18n       LocaleNames `json:"names_i18n"`
	DefaultCategory string      `json:"default_category"`
	Popularity      int         `json:"popularity"`
}

// Category is a proposed category_templates entry.
type Category struct {
	Slug      string     `json:"slug"`
	Icon      string     `json:"icon"`
	Color     string     `json:"color"`
	SortOrder int        `json:"sort_order"`
	NameI18n  LocaleName `json:"name_i18n"`
}

// LocaleNames / LocaleName give the JSON a fixed en-then-de field order,
// matching every entry in seed/items.json and seed/categories.json (a
// map[string]... would marshal alphabetically — "de" before "en"). de is
// omitted when empty: the operator adds translations by hand during review.
type LocaleNames struct {
	En []string `json:"en"`
	De []string `json:"de,omitempty"`
}

type LocaleName struct {
	En string `json:"en"`
	De string `json:"de"`
}
