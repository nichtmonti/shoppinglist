package lists

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// roster handles GET /api/lists/{listId}/members (§7.4): the only route that
// exposes member identities, since direct reads on memberships stay "own rows
// only" [D-74].
func roster(e *core.RequestEvent) error {
	listId := e.Request.PathValue("listId")

	// In membership order. A struct, not a map, so the response's key order is
	// stable.
	rows := []struct {
		Account  string         `db:"account" json:"account"`
		Joined   types.DateTime `db:"joined" json:"joined"`
		Nickname string         `db:"nickname" json:"nickname"`
	}{}
	if err := e.App.DB().NewQuery(
		"SELECT m.account AS account, COALESCE(a.nickname, '') AS nickname, m.created AS joined " +
			"FROM memberships m LEFT JOIN accounts a ON a.id = m.account " +
			"WHERE m.list = {:list} ORDER BY m.rowid",
	).Bind(dbx.Params{"list": listId}).All(&rows); err != nil {
		return e.InternalServerError("failed to load members", err)
	}

	return e.JSON(http.StatusOK, rows)
}
