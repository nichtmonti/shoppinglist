// Server-side invite minting and revocation (§7.1, [D-31]). The server mints,
// not the client, because:
//
//   - the token's entropy is an invariant only if the server makes it. Its
//     sha256 hash is what preview and join look it up by; the token itself is
//     kept while the link is live, for every member's share sheet ([D-294]);
//   - `created_by` is an authorization input to the §7.3 cascade, so it comes
//     from e.Auth, never the client;
//   - "one active link per list" is structural: revoke and create share one
//     transaction behind a partial unique index.

package invites

import (
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/randid"
	"shoppinglist/internal/security"
)

// inviteLifetime is how long a freshly minted link stays valid.
const inviteLifetime = 30 * 24 * time.Hour

// mintResponse carries the raw token; members read it back later from the row.
type mintResponse struct {
	ID        string `json:"id"`
	List      string `json:"list"`
	ExpiresAt string `json:"expires_at"`
	Revoked   bool   `json:"revoked"`
	Token     string `json:"token"`
}

// mintInvite handles POST /api/lists/{listId}/invite (§7.1, [D-31]): rotates
// the list's single active link in ONE transaction, so the list is never left
// linkless; the partial unique index makes a concurrent second rotation fail.
// The membership is checked again inside it, so a rotation racing the §7.3
// cascade leaves no invite of a deleted list.
// The old row is revoked, not deleted (§13's invite sweep wants it).
func mintInvite(e *core.RequestEvent) error {
	listID := e.Request.PathValue("listId")

	token := randid.Token()
	col, err := e.App.FindCachedCollectionByNameOrId("invites")
	if err != nil {
		return e.InternalServerError("invites collection missing", err)
	}

	rec := core.NewRecord(col)
	err = e.App.RunInTransaction(func(txApp core.App) error {
		if err := security.CheckListMembership(txApp, e); err != nil {
			return err
		}
		if _, err := RevokeLive(txApp, listID); err != nil {
			return err
		}
		rec.Set("list", listID)
		rec.Set("token_hash", randid.HashToken(token))
		rec.Set("token", token)
		rec.Set("revoked", false)
		rec.Set("created_by", e.Auth.Id) // from the token, never from the body
		rec.Set("expires_at", types.NowDateTime().Add(inviteLifetime))
		return txApp.SaveNoValidate(rec)
	})
	if err != nil {
		return security.RefusalOr500(e, "failed to mint invite", err)
	}

	return e.JSON(http.StatusOK, mintResponse{
		ID:        rec.Id,
		List:      listID,
		ExpiresAt: rec.GetString("expires_at"),
		Revoked:   false,
		Token:     token,
	})
}

// revokeInvite handles POST /api/lists/{listId}/invite/revoke (§7.1, [D-31]):
// retires the list's active link without evicting anyone. Idempotent.
func revokeInvite(e *core.RequestEvent) error {
	listID := e.Request.PathValue("listId")

	n, err := RevokeLive(e.App, listID)
	if err != nil {
		return e.InternalServerError("failed to revoke invite", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"ok": true, "revoked": n})
}

// RevokeLive marks every non-revoked invite on the list revoked and returns
// how many. Expired ones too: they still occupy the partial unique index's
// slot. The token goes with it: a dead link is no one's to share ([D-294]).
// `updated` is the revocation time Sweep ages the row by. A direct UPDATE,
// since invites have no hooks to run ([D-31]).
func RevokeLive(app core.App, listID string) (int, error) {
	res, err := app.DB().Update("invites",
		dbx.Params{"revoked": true, "token": "", "updated": types.NowDateTime()},
		dbx.HashExp{"list": listID, "revoked": false},
	).Execute()
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// Sweep deletes invites expired more than 30 days ago, and invites revoked
// more than 30 days ago (§13).
func Sweep(app core.App) error {
	_, err := app.DB().NewQuery(`DELETE FROM invites ` +
		`WHERE (expires_at != '' AND expires_at < datetime('now','-30 days')) ` +
		`OR (revoked = 1 AND updated < datetime('now','-30 days'))`).Execute()
	return err
}

// registerManageRoutes mounts the two §7.1 [D-31] routes; any member may
// share or reset the link ([D-31]).
func registerManageRoutes(r *router.RouterGroup[*core.RequestEvent]) {
	member := security.MemberRoutes(r)
	member.POST("/api/lists/{listId}/invite", mintInvite).BindFunc(security.RateLimit(security.RateInviteMint))
	member.POST("/api/lists/{listId}/invite/revoke", revokeInvite).BindFunc(security.RateLimit(security.RateInviteRevoke))
}
