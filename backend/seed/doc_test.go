package seed

import (
	"fmt"
	"strings"
	"testing"

	"shoppinglist/internal/testutil/docblock"
)

// design.md §6.12's category table is categories.json, in its order, the
// retired templates after it.
func TestDocsCategoryTable(t *testing.T) {
	docblock.Render(t, "docs/internals/design.md", "category seed", func([]string) string {
		var b, retired strings.Builder
		b.WriteString("| # | Emoji | Color | Deutsch | English | slug |\n|---|---|---|---|---|---|\n")
		for _, c := range templates {
			if c.Retired {
				fmt.Fprintf(&retired, "%s `%s` %s / %s (`%s`); ", c.Icon, c.Color, c.NameI18n["de"], c.NameI18n["en"], c.Slug)
				continue
			}
			fmt.Fprintf(&b, "| %d | %s | `%s` | %s | %s | `%s` |\n",
				c.SortOrder, c.Icon, c.Color, c.NameI18n["de"], c.NameI18n["en"], c.Slug)
		}
		if retired.Len() > 0 {
			b.WriteString("\nRetired: " + strings.TrimSuffix(retired.String(), "; ") + ".\n")
		}
		return b.String()
	})
}
