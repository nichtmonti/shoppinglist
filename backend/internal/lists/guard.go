package lists

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/fieldcontract"
)

// Register binds the lists update guard and the §7.3 departure cascade
// (cascade.go). Call it from an OnServe hook, after the migrations created
// the collections.
func Register(app core.App) {
	app.OnRecordUpdate("lists").BindFunc(listUpdateGuard)
	// Priority 100 runs inside the delete's transaction (PocketBase opens it
	// at 99), so the delete, the count and the cascade commit or roll back
	// together: a failed cascade cannot strand a list with no members.
	app.OnRecordDeleteExecute("memberships").Bind(&hook.Handler[*core.RecordEvent]{
		Func:     onMembershipDelete,
		Priority: 100,
	})
}

// listUpdateGuard bounds the one thing a member may change on a list: its
// name ([D-08]). lists.UpdateRule lets any member update the row and `name`
// is its only own column, so the rule is the allowlist and this is the bound,
// the same one the routes that write the name check ([D-08]).
func listUpdateGuard(e *core.RecordEvent) error {
	name := e.Record.GetString("name")
	if name != e.Record.Original().GetString("name") {
		if msg := listNameProblem(name); msg != "" {
			return router.NewBadRequestError(msg, nil)
		}
	}
	return e.Next()
}

// listNameProblem is the 400 message for an invalid list name (blank or over
// the contract's cap), or "" for a valid one.
func listNameProblem(name string) string {
	if strings.TrimSpace(name) == "" {
		return "name is required"
	}
	return fieldcontract.OverCap("lists", "name", name)
}
