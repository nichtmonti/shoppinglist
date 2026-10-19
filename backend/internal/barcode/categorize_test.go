package barcode

import (
	"encoding/json"
	"os"
	"testing"
)

// The category tags of popular products in Germany as Open Food Facts lists
// them (ODbL, openfoodfacts.org, 2026-10), each with the aisle a shopper
// looks in. Most of them the first-tag mapping filed under beverages:
// pasta, coffee and vegetables all open with "plant-based-foods-and-beverages".
func TestMapCategoryRealTags(t *testing.T) {
	raw, err := os.ReadFile("testdata/off-category-tags.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Want string   `json:"want"`
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 40 {
		t.Fatalf("only %d cases loaded", len(cases))
	}
	for _, c := range cases {
		if got := mapCategory(c.Tags); got != c.Want {
			t.Errorf("mapCategory(…%v) = %q, want %q", c.Tags[max(0, len(c.Tags)-3):], got, c.Want)
		}
	}
}

func TestMapCategory(t *testing.T) {
	for _, c := range []struct {
		name string
		tags []string
		want string
	}{
		{"the most specific tag decides", []string{"en:snacks", "en:breakfasts", "en:chocolate-spreads"}, "breakfast"},
		{"a root tag is no answer", []string{"en:plant-based-foods-and-beverages", "en:plant-based-foods"}, ""},
		{"an unknown specific tag falls back to a general one", []string{"en:dairies", "en:unknown-thing"}, "dairy_eggs"},
		{"tags written with spaces and another locale", []string{"fr:Sodas au cola"}, "beverages"},
		{"a whole part only: steaks are no tea", []string{"en:beef-steaks"}, "meat_fish"},
		{"peanut butter before butter", []string{"en:peanut-butters"}, "breakfast"},
		{"milk chocolate before milk", []string{"en:milk-chocolates"}, "snacks_sweets"},
		{"iced tea before tea", []string{"en:iced-teas"}, "beverages"},
		{"a pizza sauce is no pizza", []string{"en:pizza-sauces"}, "pantry"},
		{"a spirit vinegar is no spirit", []string{"en:condiments", "en:vinegars", "en:alcohol-vinegars"}, "pantry"},
		{"a rice vinegar is no rice", []string{"en:vinegars", "en:rice-vinegars"}, "pantry"},
		{"a cider vinegar is no cider", []string{"en:vinegars", "en:cider-vinegars", "en:apple-cider-vinegars"}, "pantry"},
		{"a wine vinegar is no wine", []string{"en:vinegars", "en:wine-vinegars", "en:red-wine-vinegars"}, "pantry"},
		{"a wine sauce is no wine", []string{"en:sauces", "en:red-wine-sauces"}, "pantry"},
		{"liqueur chocolates are no liqueur", []string{"en:chocolates", "en:liqueur-chocolates"}, "snacks_sweets"},
		{"a muesli with chocolate stays a muesli", []string{"en:breakfast-cereals", "en:mueslis-with-chocolate"}, "breakfast"},
		{"cheese and onion crisps are crisps", []string{"en:snacks", "en:cheese-and-onion-crisps"}, "snacks_sweets"},
		{"a cheese sauce is a sauce", []string{"en:sauces", "en:cheese-sauces"}, "pantry"},
		{"a pudding with caramel sauce stays a pudding", []string{"en:desserts", "en:rice-pudding-with-caramel-sauce"}, "dairy_eggs"},
		{"bread flour is flour", []string{"en:flours", "en:bread-flours"}, "baking_spices"},
		{"a chicken seasoning is a seasoning", []string{"en:condiments", "en:chicken-seasoning"}, "baking_spices"},
		{"salt and vinegar crisps are crisps", []string{"en:snacks", "en:salt-and-vinegar-crisps"}, "snacks_sweets"},
		{"a plural in es: potatoes are no cereal", []string{"en:plant-based-foods", "en:cereals-and-potatoes", "en:potatoes"}, "produce"},
		{"a plural in es: fishes", []string{"en:fishes"}, "meat_fish"},
		{"no tags", nil, ""},
	} {
		if got := mapCategory(c.tags); got != c.want {
			t.Errorf("%s: mapCategory(%v) = %q, want %q", c.name, c.tags, got, c.want)
		}
	}
}
