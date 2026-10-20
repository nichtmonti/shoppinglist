package lists

import (
	"errors"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/members"
	"shoppinglist/internal/security"
)

// errListLimit is populateList's refusal of a list past the [D-219] cap.
var errListLimit = errors.New("list limit reached")

// populateFailed answers a populateList error: the [D-219] refusal with code
// and max, the name's 400 as it is, anything else as a 500 carrying what. A
// body of our own, because PocketBase filters its error `data` down to
// validation errors; the contract's 409 because clone already answers 403 for
// a non-member.
func populateFailed(e *core.RequestEvent, err error, maxLists int, what string) error {
	if errors.Is(err, errListLimit) {
		status, code := fieldcontract.ListLimit()
		return e.JSON(status, map[string]any{
			"status":  status,
			"message": "list limit reached",
			"code":    code,
			"max":     maxLists,
		})
	}
	return security.RefusalOr500(e, what, err)
}

// atListLimit reports whether accountID is already a member of maxLists
// lists. Joined lists count; the (account, list) unique
// index serves the count.
func atListLimit(txApp core.App, accountID string, maxLists int) (bool, error) {
	n, err := txApp.CountRecords("memberships", dbx.HashExp{"account": accountID})
	return n >= int64(maxLists), err
}

// seedCategory is one category to copy into a fresh list. Key is the
// CALLER-LOCAL join key; populateList returns the new record ids keyed by it.
// An empty text or a zero time is what PocketBase stores for an unset column.
type seedCategory struct {
	Key       string
	Slug      string // "" ⇒ no template: Name, or the §6.7 localized default
	Name      string
	Icon      string
	Color     string
	SortOrder int
}

type seedItem struct {
	Name         string
	NameDE       string // the scanned product's localized names [D-21]
	NameEN       string
	Quantity     string
	Note         string
	CategoryKey  string         // references seedCategory.Key; "" or unknown ⇒ the §6.6 Others fallback
	Barcode      string         // the photo follows it [D-266]
	Checked      bool           // copied verbatim by clone/stateful import [D-72]; zero ⇒ fresh unchecked
	CheckedAt    types.DateTime // only meaningful with Checked
	LastBoughtAt types.DateTime // copied independently — the §6.10 purchase history, survives unchecking
	PrevBoughtAt types.DateTime // clone only: the date a tick replaced [D-303]; a backup never carries it
}

// populateList creates, in ONE transaction (§7.5 [D-72]), the lists
// row, the creator's membership, the given categories and the given items
// (fresh ids, remapped category keys, shopping state only as the seedItem
// carries it). Returns the saved lists record, a 400 for an invalid name, or
// errListLimit at the [D-219] lists cap.
//
// Every id is PocketBase's own, from crypto/rand ([D-08]): lists are not
// client-writable, unlike item and category ids (see internal/sync's
// recordIDPattern).
func populateList(app core.App, maxLists int, accountID, name string, cats []seedCategory, items []seedItem) (*core.Record, error) {
	if msg := listNameProblem(name); msg != "" {
		return nil, router.NewBadRequestError(msg, nil)
	}
	var listRec *core.Record

	err := app.RunInTransaction(func(txApp core.App) error {
		// [D-219] Inside the transaction that adds the membership, so two
		// creates racing at the cap cannot both pass.
		if full, err := atListLimit(txApp, accountID, maxLists); err != nil {
			return err
		} else if full {
			return errListLimit
		}

		listsCol, err := txApp.FindCachedCollectionByNameOrId("lists")
		if err != nil {
			return err
		}
		listRec = core.NewRecord(listsCol)
		listRec.Set("name", name) // checked above: SaveNoValidate skips field validation
		if err := txApp.SaveNoValidate(listRec); err != nil {
			return err
		}

		listID := listRec.Id
		if _, err := members.Add(txApp, accountID, listID); err != nil {
			return err
		}

		listCategoriesCol, err := txApp.FindCachedCollectionByNameOrId("list_categories")
		if err != nil {
			return err
		}
		keyMap := make(map[string]string, len(cats))
		for _, cat := range cats {
			catRec := core.NewRecord(listCategoriesCol)
			catRec.Set("list", listID)
			catRec.Set("icon", cat.Icon)
			catRec.Set("color", cat.Color)
			catRec.Set("sort_order", cat.SortOrder)
			catRec.Set("slug", cat.Slug)
			catRec.Set("name", cat.Name)
			if err := txApp.SaveNoValidate(catRec); err != nil {
				return err
			}
			keyMap[cat.Key] = catRec.Id
		}

		itemsCol, err := txApp.FindCachedCollectionByNameOrId("items")
		if err != nil {
			return err
		}
		// name_norm and the [D-266] photo are the save hooks' (sync.Register,
		// barcode.Register): never a value from the backup or the source.
		for _, item := range items {
			itemRec := core.NewRecord(itemsCol)
			itemRec.Set("list", listID)
			itemRec.Set("name", item.Name)
			itemRec.Set("quantity", item.Quantity)
			itemRec.Set("modified_by", accountID)
			itemRec.Set("name_de", item.NameDE)
			itemRec.Set("name_en", item.NameEN)
			itemRec.Set("note", item.Note)
			itemRec.Set("barcode", item.Barcode)
			itemRec.Set("category_key", keyMap[item.CategoryKey])
			itemRec.Set("checked", item.Checked)
			itemRec.Set("checked_at", item.CheckedAt)
			itemRec.Set("last_bought_at", item.LastBoughtAt)
			itemRec.Set("prev_bought_at", item.PrevBoughtAt)
			if err := txApp.SaveNoValidate(itemRec); err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return listRec, nil
}
