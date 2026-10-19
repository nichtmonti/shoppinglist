package account

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/records"
)

// renameCredential handles POST /api/credentials/{id}/rename (§5.4).
//
// `credentials` has no UpdateRule, since a client-updatable row could be
// reparented onto another account. This route checks ownership and writes
// ONLY friendly_name.
func renameCredential(e *core.RequestEvent) error {
	var body struct {
		FriendlyName string `json:"friendly_name"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("invalid request body", err)
	}
	// [D-08] the shared contract's bound, as in the webauthn begin route.
	if msg := fieldcontract.OverCap("credentials", "friendly_name", body.FriendlyName); msg != "" {
		return e.BadRequestError(msg, nil)
	}

	rec, err := records.FindFirstOptional(e.App, "credentials", dbx.HashExp{"id": e.Request.PathValue("id"), "account": e.Auth.Id})
	if err != nil {
		return e.InternalServerError("failed to load the credential", err)
	}
	if rec == nil {
		// Not found OR not owned by the caller — identical response (no enumeration).
		return e.NotFoundError("credential not found", nil)
	}

	rec.Set("friendly_name", body.FriendlyName)
	if err := e.App.SaveNoValidate(rec); err != nil {
		return e.InternalServerError("failed to rename credential", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"id": rec.Id, "friendly_name": rec.GetString("friendly_name")})
}
