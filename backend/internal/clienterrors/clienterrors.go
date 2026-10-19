// Package clienterrors receives the SPA's uncaught errors and writes them to
// the server log (POST /api/client-errors, [D-197]), the one place a
// client-side exception reaches the operator's `docker logs`.
package clienterrors

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/security"
)

// maxBody bounds the request: a report is a message and a trimmed stack.
const maxBody = 16 << 10

// report is what the client sends. Every field is optional and truncated.
type report struct {
	Message string `json:"message"`
	Stack   string `json:"stack"`
	Route   string `json:"route"`
	Path    string `json:"path"`
	Status  int    `json:"status"`
	Context string `json:"context"`
	Version string `json:"version"`
	Agent   string `json:"agent"`
}

// RegisterRoutes mounts the report route. It is not on AuthRoutes (the
// signed-out screens can fail too), so it is rate-limited per IP and writes
// nothing but one log line.
func RegisterRoutes(r *router.RouterGroup[*core.RequestEvent]) {
	r.POST("/api/client-errors", handle).Bind(apis.BodyLimit(maxBody)).BindFunc(security.RateLimit(security.RateClientError))
}

func handle(e *core.RequestEvent) error {
	var rep report
	if err := e.BindBody(&rep); err != nil {
		return e.BadRequestError("invalid report", nil)
	}
	account := "-"
	if e.Auth != nil {
		account = e.Auth.Id
	}
	log.Print(line(rep, account))
	return e.NoContent(http.StatusNoContent)
}

// line renders a report as ONE log line: every client-supplied value is
// truncated and %q-quoted, so a report cannot forge further log lines.
func line(rep report, account string) string {
	var b strings.Builder
	b.WriteString("shoppinglist: client error")
	field := func(name, value string, max int) {
		b.WriteString(" " + name + "=")
		b.WriteString(strconv.Quote(truncate(value, max)))
	}
	field("message", rep.Message, 500)
	field("route", rep.Route, 200)
	field("path", rep.Path, 200)
	b.WriteString(" status=")
	b.WriteString(strconv.Itoa(rep.Status))
	field("version", rep.Version, 50)
	field("account", account, 50)
	field("agent", rep.Agent, 300)
	field("context", rep.Context, 1000)
	field("stack", rep.Stack, 4000)
	return b.String()
}

// truncate cuts s to max bytes on a rune boundary, marking a cut with "…".
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return fieldcontract.CutBytes(s, max) + "…"
}
