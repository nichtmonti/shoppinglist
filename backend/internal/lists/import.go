package lists

import (
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
)

// The backup envelope and count caps come from internal/fieldcontract,
// shared with the frontend's backup.ts. There is exactly ONE document
// version, shopping state included ([D-72]); any other is refused, not
// migrated.

type importCategoryPayload struct {
	Key       string  `json:"key"`
	Slug      *string `json:"slug"`
	Name      *string `json:"name"`
	Icon      string  `json:"icon"`
	Color     string  `json:"color"`
	SortOrder int     `json:"sort_order"`
}

type importItemPayload struct {
	Name        string  `json:"name"`
	NameDE      *string `json:"name_de"`
	NameEN      *string `json:"name_en"`
	Quantity    string  `json:"quantity"`
	Note        *string `json:"note"`
	CategoryKey *string `json:"category_key"`
	Barcode     *string `json:"barcode"`
	// A backup's image_url is not read: the photo follows the barcode ([D-266]).
	Checked      *bool           `json:"checked"`
	CheckedAt    *types.DateTime `json:"checked_at"`
	LastBoughtAt *types.DateTime `json:"last_bought_at"`
}

type importBackupPayload struct {
	Format      string                  `json:"format"`
	Version     int                     `json:"version"`
	ExportedAt  string                  `json:"exported_at"`
	DisplayName string                  `json:"display_name"`
	Categories  []importCategoryPayload `json:"categories"`
	Items       []importItemPayload     `json:"items"`
}

// importListBody carries the parsed backup and an optional name; the new
// list's id is SERVER-minted ([D-08]).
type importListBody struct {
	Name   string              `json:"name"`
	Backup importBackupPayload `json:"backup"`
}

// importList handles POST /api/lists/import (§7.5 [D-72]): restores a
// per-list backup into a fresh list owned by the caller, never merging. Rows
// get fresh ids; shopping state is restored verbatim [D-72]; unknown and
// server-stamped fields are dropped by construction.
//
// The list is named by the body's `name`, else by the file's `display_name`
// ([D-08]); blank counts as absent.
func (h handlers) importList(e *core.RequestEvent) error {
	var body importListBody
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}
	if msg, err := validateBackup(e.App, body.Backup, h.caps.ImportMax()); err != nil {
		return e.InternalServerError("failed to load category templates", err)
	} else if msg != "" {
		return e.BadRequestError(msg, nil)
	}

	name := body.Name
	if strings.TrimSpace(name) == "" {
		name = body.Backup.DisplayName
	}
	cats, items := body.Backup.toSeed()
	listRec, err := populateList(e.App, h.caps.Lists, e.Auth.Id, name, cats, items)
	if err != nil {
		return populateFailed(e, err, h.caps.Lists, "failed to import list")
	}

	return e.JSON(http.StatusOK, listRec)
}

// validateBackup returns the 400 message for the first problem in the
// document, or "" for one importList may restore. The error is a failure to
// load the slug allowlist (templateSlugSet).
func validateBackup(app core.App, b importBackupPayload, maxItems int) (string, error) {
	if b.Format != fieldcontract.BackupFormat() {
		return "unsupported backup format", nil
	}
	if b.Version != fieldcontract.BackupVersion() {
		return "unsupported backup version", nil
	}

	if len(b.Categories) > fieldcontract.MaxBackupCategories() {
		return "too many categories", nil
	}
	// [D-217] An import must not create a list the push route calls full.
	if len(b.Items) > maxItems {
		return "too many items", nil
	}

	// [D-08] `slug` is SERVER-OWNED, and this is the one route that receives
	// it from a client. Taken verbatim, a crafted file could store an unbounded
	// slug or mint any number of undeletable `other` rows ([D-30]). So only
	// template slugs are accepted, each once, as in any genuine export. A key
	// is unique too: items find their category by it.
	templateSlugs, err := templateSlugSet(app)
	if err != nil {
		return "", err
	}
	keySet := make(map[string]struct{}, len(b.Categories))
	seenSlugs := make(map[string]struct{}, len(b.Categories))
	for _, cat := range b.Categories {
		if cat.Key == "" {
			return "category key is required", nil
		}
		if _, dup := keySet[cat.Key]; dup {
			return "duplicate category key", nil
		}
		keySet[cat.Key] = struct{}{}
		if cat.Slug != nil { // null ⇒ a member-added row; renders its own `name` (§6.6)
			if _, ok := templateSlugs[*cat.Slug]; !ok {
				return "unknown category slug", nil
			}
			if _, dup := seenSlugs[*cat.Slug]; dup {
				return "duplicate category slug", nil
			}
			seenSlugs[*cat.Slug] = struct{}{}
		}
		if msg := firstOverCap("list_categories", []fieldValue{
			{"name", strOrEmpty(cat.Name)},
			{"icon", cat.Icon},
			{"color", cat.Color},
		}); msg != "" {
			return msg, nil
		}
	}

	// One future-tolerance deadline per request, not one time.Now() per item.
	deadline := time.Now().Add(5 * time.Minute)
	for _, item := range b.Items {
		if msg := firstOverCap("items", []fieldValue{
			{"name", item.Name},
			{"name_de", strOrEmpty(item.NameDE)},
			{"name_en", strOrEmpty(item.NameEN)},
			{"quantity", item.Quantity},
			{"note", strOrEmpty(item.Note)},
			{"barcode", strOrEmpty(item.Barcode)},
		}); msg != "" {
			return msg, nil
		}
		if msg := shoppingStateProblem(item, deadline); msg != "" {
			return msg, nil
		}
		if item.CategoryKey != nil {
			if _, ok := keySet[*item.CategoryKey]; !ok {
				return "unknown category reference", nil
			}
		}
	}
	return "", nil
}

// shoppingStateProblem checks an item's [D-72] shopping state: the stamps must
// parse, and must combine the way the push route writes them.
func shoppingStateProblem(item importItemPayload, deadline time.Time) string {
	// A string that does not parse decodes to the zero time without an error.
	if item.CheckedAt != nil {
		if item.CheckedAt.IsZero() {
			return "invalid checked_at"
		}
		// The server only ever stamps the two together ([D-26]).
		if item.Checked == nil || !*item.Checked {
			return "checked_at requires checked"
		}
		// Both stamps must be EQUAL: the push route stamps them with one now(),
		// and divergent ones would show the row in the done section AND
		// "Frühere Artikel" at once.
		if item.LastBoughtAt != nil && !item.LastBoughtAt.Equal(*item.CheckedAt) {
			return "checked_at and last_bought_at must match"
		}
		// The reverse (last_bought_at alone, checked false) is the legitimate
		// re-added state and stays importable.
		if item.LastBoughtAt == nil {
			return "checked_at requires last_bought_at"
		}
	}
	if item.LastBoughtAt != nil {
		if item.LastBoughtAt.IsZero() {
			return "invalid last_bought_at"
		}
		// A future stamp is clock skew or tampering. checked_at needs no check
		// of its own: it equals last_bought_at.
		if item.LastBoughtAt.Time().After(deadline) {
			return "last_bought_at is in the future"
		}
	}
	return ""
}

// fieldValue is one text field of an imported row, for firstOverCap.
type fieldValue struct {
	field, value string
}

// firstOverCap is the contract's message for the first value over its
// collection's cap, or "".
func firstOverCap(collection string, values []fieldValue) string {
	for _, v := range values {
		if msg := fieldcontract.OverCap(collection, v.field, v.value); msg != "" {
			return msg
		}
	}
	return ""
}

// toSeed maps a validated document onto populateList's input.
func (b importBackupPayload) toSeed() ([]seedCategory, []seedItem) {
	cats := make([]seedCategory, 0, len(b.Categories))
	for _, cat := range b.Categories {
		cats = append(cats, seedCategory{
			Key:       cat.Key,
			Slug:      strOrEmpty(cat.Slug),
			Name:      strOrEmpty(cat.Name),
			Icon:      cat.Icon,
			Color:     cat.Color,
			SortOrder: cat.SortOrder,
		})
	}

	items := make([]seedItem, 0, len(b.Items))
	for _, item := range b.Items {
		items = append(items, seedItem{
			Name:         item.Name,
			NameDE:       strOrEmpty(item.NameDE),
			NameEN:       strOrEmpty(item.NameEN),
			Quantity:     item.Quantity,
			Note:         strOrEmpty(item.Note),
			CategoryKey:  strOrEmpty(item.CategoryKey),
			Barcode:      strOrEmpty(item.Barcode),
			Checked:      item.Checked != nil && *item.Checked, // absent means never ticked
			CheckedAt:    timeOrZero(item.CheckedAt),
			LastBoughtAt: timeOrZero(item.LastBoughtAt),
		})
	}
	return cats, items
}

// templateSlugSet is the set of slugs the server itself mints, the allowlist
// for an imported document's slugs ([D-08]).
func templateSlugSet(app core.App) (map[string]struct{}, error) {
	templates, err := app.FindAllRecords("category_templates")
	if err != nil {
		return nil, err
	}
	set := make(map[string]struct{}, len(templates))
	for _, tpl := range templates {
		set[tpl.GetString("slug")] = struct{}{}
	}
	return set, nil
}

// timeOrZero dereferences a nullable date payload field.
func timeOrZero(t *types.DateTime) types.DateTime {
	if t == nil {
		return types.DateTime{}
	}
	return *t
}

// strOrEmpty dereferences a nullable string payload field.
func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
