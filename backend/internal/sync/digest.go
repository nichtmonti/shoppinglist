package sync

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// digestEntry represents a single list's digest in the response.
type digestEntry struct {
	ListID     string `json:"list_id"`
	RowCount   int    `json:"row_count"`
	MaxUpdated string `json:"max_updated"`
	Hash       string `json:"hash"`
	// Name rides here so a rename reaches co-members next cycle ([D-08]).
	Name       string         `json:"name"`
	Membership membershipView `json:"membership"`
}

// membershipView is the caller's own membership row for the entry's list
// ([D-28]). The entries ARE the caller's membership set; on AuthRoutes
// an invalid token is a 401, never a rule-filtered 200-empty, so the client
// can take an empty array as "no lists" ([D-28]).
type membershipView struct {
	ID      string `json:"id"`
	Account string `json:"account"`
	List    string `json:"list"`
	Created string `json:"created"`
	Updated string `json:"updated"`
}

// digestHandler implements GET /api/sync/digest (§8.5): one digestEntry per
// list the caller is a member of.
func digestHandler(e *core.RequestEvent) error {
	callerID := e.Auth.Id

	memberships, err := e.App.FindAllRecords("memberships", dbx.HashExp{"account": callerID})
	if err != nil {
		return e.InternalServerError("failed to fetch memberships", err)
	}

	// The lists' names, in one read.
	listIDs := make([]any, 0, len(memberships))
	for _, mem := range memberships {
		listIDs = append(listIDs, mem.GetString("list"))
	}
	var named []struct {
		ID   string `db:"id"`
		Name string `db:"name"`
	}
	if len(listIDs) > 0 {
		if err := e.App.DB().Select("id", "name").From("lists").
			Where(dbx.In("id", listIDs...)).All(&named); err != nil {
			return e.InternalServerError("failed to fetch list names", err)
		}
	}
	names := make(map[string]string, len(named))
	for _, l := range named {
		names[l.ID] = l.Name
	}

	entries := make([]digestEntry, 0, len(memberships))

	for _, mem := range memberships {
		listID := mem.GetString("list")

		// Only the two hashed columns, never whole records: this runs every
		// ~60s cycle per device.
		var keys []rowKey
		err := e.App.DB().NewQuery(
			"SELECT id, updated FROM items WHERE list = {:listId} " +
				"UNION ALL SELECT id, updated FROM list_categories WHERE list = {:listId}",
		).Bind(dbx.Params{"listId": listID}).All(&keys)
		if err != nil {
			return e.InternalServerError("failed to fetch rows", err)
		}

		hash, rowCount, maxUpdated := digestOf(keys)

		entries = append(entries, digestEntry{
			ListID:     listID,
			RowCount:   rowCount,
			MaxUpdated: maxUpdated,
			Hash:       hash,
			Name:       names[listID],
			Membership: membershipView{
				ID:      mem.Id,
				Account: mem.GetString("account"),
				List:    listID,
				Created: mem.GetDateTime("created").String(),
				Updated: mem.GetDateTime("updated").String(),
			},
		})
	}

	slices.SortFunc(entries, func(a, b digestEntry) int { return strings.Compare(a.ListID, b.ListID) })

	return e.JSON(http.StatusOK, entries)
}

// rowKey is the only part of a row the digest looks at. Its fields are
// EXPORTED because dbx reflection cannot set unexported ones (a 500).
type rowKey struct {
	Id      string `db:"id"`
	Updated string `db:"updated"`
}

// digestOf is the digest algorithm, kept free of PocketBase types so
// seed/digest-vectors.json can pin it against its twin in
// frontend/src/lib/sync/digest.ts; a divergence would force a full snapshot
// pull every cycle.
//
//   - hash: SHA-256 hex of the sorted "{id}:{updated}" pairs joined with "\n"
//     (the empty set hashes the empty string)
//   - rowCount: number of rows
//   - maxUpdated: lexicographically greatest `updated` ("" for no rows)
func digestOf(keys []rowKey) (hash string, rowCount int, maxUpdated string) {
	pairs := make([]string, len(keys))
	for i, k := range keys {
		pairs[i] = k.Id + ":" + k.Updated
		if k.Updated > maxUpdated {
			maxUpdated = k.Updated
		}
	}
	slices.Sort(pairs)

	sum := sha256.Sum256([]byte(strings.Join(pairs, "\n")))
	return hex.EncodeToString(sum[:]), len(keys), maxUpdated
}
