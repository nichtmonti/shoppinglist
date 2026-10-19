package barcode

import (
	"regexp"
	"slices"
	"strings"
)

// localePrefix strips the `xx:` language prefix from an OFF/OBF category tag.
var localePrefix = regexp.MustCompile(`^[a-z]{2,3}:`)

// separators turns a tag written with spaces ("Sodas au cola") into the
// hyphenated form the rules read.
var separators = regexp.MustCompile(`[\s_]+`)

// seg matches whole hyphen-separated parts of a tag, plural s or es optional:
// seg("tea") finds "green-teas" but not "steaks", seg("potato") "potatoes".
func seg(words string) string {
	return `(?:^|-)(?:` + words + `)(?:e?s)?(?:-|$)`
}

// rootTags say nothing about the aisle: Open Food Facts files pasta, coffee
// and vegetables alike under them, and they would read as "beverages".
var rootTags = map[string]bool{
	"plant-based-foods-and-beverages": true,
	"plant-based-foods":               true,
	"foods-and-beverages":             true,
}

// categoryRules map a category tag to a seed slug. A tag takes the first rule
// it matches, so a narrow rule precedes a broad one that would also match:
// peanut butter before butter, milk chocolate before milk, iced tea before tea.
var categoryRules = []struct {
	pattern *regexp.Regexp
	slug    string
}{
	{regexp.MustCompile(`sunscreen|sun-protection|sun-care|cosmetic|shampoo|toothpaste|deodorant|soap|skin-care|hygiene|beauty|supplement`), "personal_care"},
	{regexp.MustCompile(`baby-food|baby-milk|infant|baby-formula`), "baby"},
	{regexp.MustCompile(`pet-food|petfood|cat-food|dog-food|` + seg(`pet`)), "pet"},
	{regexp.MustCompile(`frozen|ice-cream|sorbet`), "frozen"},
	{regexp.MustCompile(`canned|tinned|conserve|soup|tomato-paste|tomato-pulp|gherkin|cornichon|pizza-sauce`), "pantry"},
	{regexp.MustCompile(`pizza`), "frozen"},
	// A tag ending in the product names what went into it, which a rule
	// below would read: "alcohol-vinegars", "red-wine-sauces", "cheese-sauces",
	// "liqueur-chocolates", "cheese-and-onion-crisps", "bread-flours",
	// "chicken-seasoning". A dish named after its sauce or chocolate takes
	// the singular and stays where it was ("rice-pudding-with-caramel-sauce",
	// "mueslis-with-chocolate").
	{regexp.MustCompile(`(?:^|-)(?:sauces|vinegars?)$`), "pantry"},
	{regexp.MustCompile(`(?:^|-)(?:chocolates|crisps|chips)$`), "snacks_sweets"},
	{regexp.MustCompile(`(?:^|-)(?:flours|seasonings?)$`), "baking_spices"},
	{regexp.MustCompile(`milk-substitute|milk-alternative|based-drink|non-dairy|dairy-substitute|soy-milk|coconutmilk|tofu|meat-alternative|meat-analogue|cheese-substitute|fermented-milk|milk-drink|dairy-drink|dairy-dessert|margarine|hummus`), "dairy_eggs"},
	{regexp.MustCompile(`iced-tea|ice-tea`), "beverages"},
	{regexp.MustCompile(`coffee|` + seg(`tea`) + `|infusion|chicory|chocolate-powder|cocoa-and-chocolate-powders|cocoa-powders?-for-beverage|hot-chocolate|instant-chocolate|cappuccino|espresso`), "coffee_tea"},
	{regexp.MustCompile(seg(`bar`) + `|cereal-bar|granola-bar|rice-cake|rice-cracker`), "snacks_sweets"},
	{regexp.MustCompile(`cheese|fromage|quark|skyr|mozzarella|pasta-filata|kaese|käse|queso|formaggi|kaas|pudding`), "dairy_eggs"},
	{regexp.MustCompile(`nut-butter|peanut-butter|spread|` + seg(`honey|honie|jam|marmalade|confiture|jellie|jelly`) + `|maple-syrup|nutella|breakfast|petit-dejeuner`), "breakfast"},
	{regexp.MustCompile(seg(`beer|wine|alcohol|spirit|liqueur|cider|champagne|prosecco|vodka|gin|rum|whisky|whiskey`) + `|alcoholic`), "alcohol"},
	{regexp.MustCompile(`beverage|` + seg(`drink|water|juice|nectar|soda|cola|lemonade|syrup|smoothie`) + `|energy-drink|soft-drink|mineral-water`), "beverages"},
	{regexp.MustCompile(`pasta|` + seg(`rice`) + `|noodle|spaghetti|penne|fusilli|lasagn|linguine|macaroni|couscous|quinoa|bulgur|` + seg(`grain`) + `|pulse|legume-seed|gnocchi|coquillette|semolina`), "pasta_rice"},
	{regexp.MustCompile(`cereal|muesli|` + seg(`oat`) + `|rolled-oat|flakes|granola|porridge|puffed|` + seg(`bran`)), "breakfast"},
	{regexp.MustCompile(`snack|candy|candies|sweets|chocolat|schokolade|biscuit|cookie|confection|crisps|chips|` + seg(`nut|almond|cashew|pistachio|peanut|walnut|hazelnut|pecan|brazil-nut`) + `|dried-fruit|` + seg(`cake`) + `|gumm|bonbon|praline|marshmallow|popcorn|pretzel|cracker|wafer|licorice|speculoos|speculaas`), "snacks_sweets"},
	{regexp.MustCompile(`dair|milk|yogurt|yoghurt|kefir|` + seg(`butter|cream|egg|pudding`)), "dairy_eggs"},
	{regexp.MustCompile(`bread|bakery|bakeries|pastr|viennoiserie|brioche|crispbread|` + seg(`toast|rusk|croissant|bagel|baguette|bun|roll`)), "bakery"},
	{regexp.MustCompile(`spice|baking|flour|` + seg(`sugar|salt|yeast|starch|vanilla|pepper`) + `|raising|food-additive|cocoa-powder`), "baking_spices"},
	{regexp.MustCompile(`prepared/processed|prepared-lentil|pantry|preserve|sauce|ketchup|mustard|mayonnaise|pesto|vinegar|` + seg(`oil|olive|pickle|chickpea|legume|bean|soup|chutney|condiment|dressing|vinaigrette|bouillon|stock|broth`) + `|tomato-puree|fried-onion`), "pantry"},
	{regexp.MustCompile(`meat|poultry|sausage|` + seg(`fish|seafood|ham|salami|bacon|tuna|salmon|mackerel|sardine|shrimp|prawn|chicken|beef|pork|turkey`)), "meat_fish"},
	{regexp.MustCompile(`clean|detergent|household|dishwash|laundry|toilet-paper`), "household"},
	{regexp.MustCompile(`fruit|vegetable|produce|` + seg(`potato|salad|onion|tomato|apple|banana|berry|berrie|citrus|lettuce|carrot`)), "produce"},
}

// mapCategory reads a product's category tags from the most specific, which
// Open Food Facts lists last, to the most general, and returns the slug of
// the first tag a rule matches; "" when none does, and the client's
// classifier decides.
func mapCategory(tags []string) string {
	for _, tag := range slices.Backward(tags) {
		tag := localePrefix.ReplaceAllString(strings.ToLower(strings.TrimSpace(tag)), "")
		tag = separators.ReplaceAllString(tag, "-")
		if rootTags[tag] {
			continue
		}
		for _, rule := range categoryRules {
			if rule.pattern.MatchString(tag) {
				return rule.slug
			}
		}
	}
	return ""
}
