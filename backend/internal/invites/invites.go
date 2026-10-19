// Package invites implements the §7.1/§7.6 invite flow: an unauthenticated
// preview of an invite's list, an authenticated join, and the member-only
// routes that mint and revoke a list's single active link ([D-31],
// manage.go).
//
// Only these routes write invites (CreateRule/UpdateRule are nil). Members
// may read the rows for the link's expiry; token_hash discloses nothing.
package invites

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/members"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/records"
	"shoppinglist/internal/security"
)

// errInviteInvalid is the one error for not found, revoked and expired alike,
// so the response cannot distinguish them.
const errInviteInvalid = "invite not found, expired, or revoked"

// RegisterRoutes mounts the §7.1/§7.6 invite endpoints on the serve router.
func RegisterRoutes(router *router.RouterGroup[*core.RequestEvent]) {
	router.POST("/api/invites/preview", previewHandler).BindFunc(security.RateLimit(security.RateInvitePreview))
	security.AuthRoutes(router).POST("/api/invites/join", joinHandler).BindFunc(security.RateLimit(security.RateInviteJoin))
	registerManageRoutes(router) // §7.1 [D-31] mint + revoke
}

type tokenBody struct {
	Token string `json:"token"`
}

// LiveListByHash returns the list a live invite with this token hash opens,
// ok=false on the same refusals join makes ([D-241]).
func LiveListByHash(app core.App, hash string) (string, bool, error) {
	invite, err := findValidByHash(app, hash)
	if err != nil || invite == nil {
		return "", false, err
	}
	listID := invite.GetString("list")
	list, err := records.FindOptional(app, "lists", listID)
	if err != nil || list == nil {
		return "", false, err
	}
	return listID, true, nil
}

// findValidByHash looks up the live invite by its token's hash: nil for not
// found, revoked and expired alike, an error only when the lookup failed.
func findValidByHash(app core.App, hash string) (*core.Record, error) {
	rec, err := records.FindFirstOptional(app, "invites", dbx.HashExp{"token_hash": hash})
	if err != nil || rec == nil {
		return nil, err
	}
	if rec.GetBool("revoked") {
		return nil, nil
	}
	expiresAt := rec.GetDateTime("expires_at")
	if !expiresAt.IsZero() && expiresAt.Before(types.NowDateTime()) {
		return nil, nil
	}
	return rec, nil
}

// itemSnap is the only part of an item the invite preview carries, the
// localized names as members see them ([D-21]): null when unset. Fields are
// EXPORTED because dbx cannot scan into unexported ones.
type itemSnap struct {
	Name     string  `db:"name" json:"name"`
	NameDE   *string `db:"name_de" json:"name_de"`
	NameEN   *string `db:"name_en" json:"name_en"`
	Quantity string  `db:"quantity" json:"quantity"`
}

func previewHandler(e *core.RequestEvent) error {
	var body tokenBody
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}
	hash, ok := randid.LookupHash(body.Token)
	if !ok {
		return e.BadRequestError(errInviteInvalid, nil)
	}

	invite, err := findValidByHash(e.App, hash)
	if err != nil {
		return e.InternalServerError("failed to load the invite", err)
	}
	if invite == nil {
		return e.BadRequestError(errInviteInvalid, nil)
	}

	// The list's own name ([D-08]).
	listID := invite.GetString("list")
	list, err := records.FindOptional(e.App, "lists", listID)
	if err != nil {
		return e.InternalServerError("failed to load list", err)
	}
	if list == nil {
		return e.BadRequestError(errInviteInvalid, nil)
	}

	// Only the columns the preview emits; notes and photos stay out. In the
	// order they were added, so the few the join screen names stay the same.
	snaps := []itemSnap{}
	if err := e.App.DB().NewQuery(
		"SELECT name, NULLIF(name_de, '') AS name_de, NULLIF(name_en, '') AS name_en, quantity " +
			"FROM items WHERE list = {:list} AND deleted_at = '' ORDER BY created, id",
	).Bind(dbx.Params{"list": listID}).All(&snaps); err != nil {
		return e.InternalServerError("failed to load items", err)
	}

	memberCount, err := e.App.CountRecords("memberships", dbx.HashExp{"list": listID})
	if err != nil {
		return e.InternalServerError("failed to count members", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"name":         list.GetString("name"),
		"items":        snaps,
		"member_count": memberCount,
	})
}

func joinHandler(e *core.RequestEvent) error {
	var body tokenBody
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}
	hash, ok := randid.LookupHash(body.Token)
	if !ok {
		return e.BadRequestError(errInviteInvalid, nil)
	}
	// One transaction from the invite check to the insert: a double-tapped
	// join finds the first one's membership, and a join racing the §7.3
	// cascade never leaves a membership of a deleted list.
	var membership *core.Record
	err := e.App.RunInTransaction(func(txApp core.App) error {
		listID, live, err := LiveListByHash(txApp, hash)
		if err != nil {
			return err
		}
		if !live {
			return e.BadRequestError(errInviteInvalid, nil)
		}

		existing, err := members.Find(txApp, e.Auth.Id, listID)
		if err != nil {
			return err
		}
		if existing != nil {
			membership = existing // already a member: joining is idempotent
			return nil
		}

		membership, err = members.Add(txApp, e.Auth.Id, listID)
		return err
	})
	if err != nil {
		return security.RefusalOr500(e, "failed to create membership", err)
	}
	return e.JSON(http.StatusOK, membership)
}
