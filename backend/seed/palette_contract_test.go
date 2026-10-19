package seed

import (
	"testing"

	"shoppinglist/internal/fieldcontract"
)

// TestSeedCategoryColorsWithinContractPalette pins every seed category color to
// the shared contract's palette, the single source categories.ts, app.css and
// this seed are held to: a typo in the seed would otherwise render gray with
// no error anywhere.
func TestSeedCategoryColorsWithinContractPalette(t *testing.T) {
	palette := make(map[string]bool, len(fieldcontract.Palette()))
	for _, c := range fieldcontract.Palette() {
		palette[c] = true
	}
	for _, r := range templates {
		if r.Color == "" {
			t.Errorf("category %q has an empty color", r.Slug)
			continue
		}
		if !palette[r.Color] {
			t.Errorf("category %q color %q is not in the contract palette", r.Slug, r.Color)
		}
	}
}
