// Package seed implements the idempotent boot seeder for the global reference
// collections (category_templates, item_dictionary), §6.12. The JSON is
// embedded so a network-less boot seeds correctly. Re-application is gated on
// a stored seed_version so superuser edits survive between content bumps.
//
// Records are saved with SaveNoValidate: item_dictionary's short deterministic
// ids (e.g. "item_cucumber", §6.9) fail PocketBase's 15-character id rule.
package seed

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/normalize"
	"shoppinglist/internal/records"
)

// CurrentSeedVersion is bumped when the embedded seed content changes; the
// seed is re-applied only when the stored version differs.
const CurrentSeedVersion = "10"

//go:embed categories.json
var categoriesFS []byte

//go:embed items.json
var itemsFS []byte

// templates and dictionary are the embedded seed, parsed once: embedded at
// build time, so a parse failure is a broken build, as in internal/ui.
var (
	templates  = mustParse[categorySeed](categoriesFS)
	dictionary = mustParse[itemSeed](itemsFS)
)

func mustParse[T any](raw []byte) []T {
	var rows []T
	if err := json.Unmarshal(raw, &rows); err != nil {
		panic(fmt.Sprintf("seed: cannot parse the embedded seed: %v", err))
	}
	return rows
}

// ParamKeySeedVersion is the _params row the applied seed version is stored
// under.
const ParamKeySeedVersion = "seed_version"

// sepRe collapses whitespace and hyphens to a single underscore when deriving an
// item_dictionary id (e.g. "all-purpose cleaner" -> "all_purpose_cleaner").
var sepRe = regexp.MustCompile(`[\s\-]+`)

type categorySeed struct {
	Slug      string            `json:"slug"`
	Icon      string            `json:"icon"`
	Color     string            `json:"color"`
	SortOrder int               `json:"sort_order"`
	Retired   bool              `json:"retired"`
	NameI18n  map[string]string `json:"name_i18n"`
}

type itemSeed struct {
	ID              string              `json:"id"`
	NamesI18n       map[string][]string `json:"names_i18n"`
	DefaultCategory string              `json:"default_category"`
	Popularity      int                 `json:"popularity"`
}

// ItemID derives the deterministic item_dictionary id from a canonical en name
// (§6.12). cmd/appendseed uses it so both derive ids the same way.
func ItemID(enName string) string {
	return "item_" + sepRe.ReplaceAllString(normalize.Name(enName), "_")
}

// Run applies the embedded seed if the stored seed_version differs from
// CurrentSeedVersion, and is a no-op otherwise. Safe on every boot.
func Run(app core.App) error {
	stored, err := readSeedVersion(app)
	if err != nil {
		return err
	}
	if stored == CurrentSeedVersion {
		return nil
	}
	// It can take a while on a slow disk, and the server answers no request
	// until it is done: say so, or a long seed reads as a hung boot.
	start := time.Now()
	applog.Info(app, "applying the seed; the server starts when it is done", "version", CurrentSeedVersion, "stored", stored)
	// One transaction: one commit for the whole seed instead of one per row,
	// and the version is stored only with the rows it stands for.
	err = app.RunInTransaction(func(tx core.App) error {
		if err := seedCategories(tx); err != nil {
			return err
		}
		if err := seedItems(tx); err != nil {
			return err
		}
		if v, _ := strconv.Atoi(stored); v < foldVersion {
			if err := foldOldAisles(tx); err != nil {
				return err
			}
		}
		return writeSeedVersion(tx, CurrentSeedVersion)
	})
	if err != nil {
		return err
	}
	applog.Info(app, "seed applied", "version", CurrentSeedVersion, "took", time.Since(start).Round(time.Millisecond))
	return nil
}

func seedCategories(app core.App) error {
	col, err := app.FindCollectionByNameOrId("category_templates")
	if err != nil {
		return err
	}
	for _, r := range templates {
		rec, err := records.FindFirstOptional(app, "category_templates", dbx.HashExp{"slug": r.Slug})
		if err != nil {
			return err
		}
		if rec == nil {
			rec = core.NewRecord(col)
			rec.Set("slug", r.Slug)
		} else if old := rec.GetString("icon"); old != r.Icon {
			if err := followDefaultIcon(app, r.Slug, old, r.Icon); err != nil {
				return err
			}
		}
		rec.Set("name_i18n", r.NameI18n)
		rec.Set("icon", r.Icon)
		rec.Set("color", r.Color)
		rec.Set("sort_order", r.SortOrder)
		rec.Set("retired", r.Retired)
		if err := app.SaveNoValidate(rec); err != nil {
			return err
		}
	}
	return nil
}

// followDefaultIcon moves every list's category for slug from the template's
// old icon to its new one ([D-287]). A list copies its icons when it is
// created ([D-14]), so without this only new lists would show a changed
// default; a row whose icon someone changed keeps it. Saving stamps
// `updated`, so devices pull the row on their next sync.
func followDefaultIcon(app core.App, slug, oldIcon, newIcon string) error {
	rows, err := app.FindAllRecords("list_categories",
		dbx.HashExp{"slug": slug, "icon": oldIcon})
	if err != nil {
		return err
	}
	for _, row := range rows {
		row.Set("icon", newIcon)
		if err := app.SaveNoValidate(row); err != nil {
			return err
		}
	}
	return nil
}

func seedItems(app core.App) error {
	col, err := app.FindCollectionByNameOrId("item_dictionary")
	if err != nil {
		return err
	}
	for _, r := range dictionary {
		en := ""
		if v := r.NamesI18n["en"]; len(v) > 0 {
			en = v[0]
		}
		id := ItemID(en)
		rec, err := records.FindOptional(app, "item_dictionary", id)
		if err != nil {
			return err
		}
		if rec == nil {
			rec = core.NewRecord(col)
			rec.Id = id
		}
		rec.Set("names_i18n", r.NamesI18n)
		rec.Set("default_category", r.DefaultCategory)
		rec.Set("popularity", r.Popularity)
		if err := app.SaveNoValidate(rec); err != nil {
			return err
		}
	}
	return nil
}

func readSeedVersion(app core.App) (string, error) {
	p := &core.Param{}
	err := app.ModelQuery(p).Model(ParamKeySeedVersion, p)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var v string
	if err := json.Unmarshal(p.Value, &v); err != nil {
		return "", nil // malformed stored value -> re-seed
	}
	return v, nil
}

func writeSeedVersion(app core.App, version string) error {
	raw, err := json.Marshal(version)
	if err != nil {
		return err
	}
	p := &core.Param{}
	if err := app.ModelQuery(p).Model(ParamKeySeedVersion, p); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		p = &core.Param{}
		p.Id = ParamKeySeedVersion
		p.MarkAsNew()
	}
	p.Value = types.JSONRaw(raw)
	return app.Save(p)
}
