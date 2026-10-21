package security

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"shoppinglist/internal/testutil/docblock"
)

// [D-307] design.md §10's rate-limit table is policy, in the order of the
// budget constants, each with the routes its comment names; the routes left
// without one are unlimited.
func TestDocsRateLimits(t *testing.T) {
	budgets := budgetComments(t)
	if len(budgets) != len(policy) {
		t.Errorf("%d budget constants, %d budgets in policy", len(budgets), len(policy))
	}
	docblock.Render(t, "docs/internals/design.md", "rate limits", func([]string) string {
		var b strings.Builder
		b.WriteString("| Budget | Calls per IP | Routes |\n|---|---|---|\n")
		for _, c := range budgets {
			p, ok := policy[c.name]
			if !ok {
				t.Errorf("%s has no budget in policy", c.name)
			}
			fmt.Fprintf(&b, "| `%s` | %d per %s | %s |\n", c.name, p.max, per(p.window), c.routes)
		}
		return b.String()
	})
	docblock.Render(t, "docs/internals/design.md", "unlimited routes", func([]string) string {
		var b strings.Builder
		for _, u := range unlimited {
			fmt.Fprintf(&b, "- `%s`: %s.\n", u.route, u.why)
		}
		return b.String()
	})
}

// Every custom route the backend registers has a budget or is named as left
// without one, so a new route cannot miss both.
func TestEveryRouteHasABudget(t *testing.T) {
	named := map[string]bool{
		// Outside the table: the demo build's own budget (security.Limit),
		// and the JSON 404 for every /api/ path no route has.
		"POST /api/demo/start": true,
		"GET /api/{path...}":   true,
	}
	for _, c := range budgetComments(t) {
		for _, m := range routeName.FindAllStringSubmatch(c.routes, -1) {
			named[m[1]] = true
		}
	}
	for _, u := range unlimited {
		named[u.route] = true
	}
	registered := regexp.MustCompile(`\.(GET|POST|PUT|PATCH|DELETE)\("(/api/[^"]*)"`)
	err := filepath.WalkDir("../..", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && strings.HasPrefix(d.Name(), "pb_") {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range registered.FindAllStringSubmatch(string(src), -1) {
			if route := m[1] + " " + m[2]; !named[route] {
				t.Errorf("%s registers %s, which has no budget in ratelimit.go and is not named as left without one",
					strings.TrimPrefix(path, "../../"), route)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

var routeName = regexp.MustCompile("`((?:GET|POST|PUT|PATCH|DELETE) /api/[^`]*)`")

type budgetComment struct {
	name   budgetName
	routes string
}

// budgetComments is each budget constant's value and line comment in
// ratelimit.go, in order.
func budgetComments(t *testing.T) []budgetComment {
	file, err := parser.ParseFile(token.NewFileSet(), "ratelimit.go", nil, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	var out []budgetComment
	for _, d := range file.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok || g.Tok != token.CONST {
			continue
		}
		for _, spec := range g.Specs {
			v := spec.(*ast.ValueSpec)
			if id, ok := v.Type.(*ast.Ident); !ok || id.Name != "budgetName" {
				continue
			}
			name, err := strconv.Unquote(v.Values[0].(*ast.BasicLit).Value)
			if err != nil {
				t.Fatal(err)
			}
			routes := strings.TrimSpace(v.Comment.Text())
			if !routeName.MatchString(routes) {
				t.Errorf("%s's comment names no route", v.Names[0].Name)
			}
			out = append(out, budgetComment{budgetName(name), routes})
		}
	}
	return out
}

// per is a window in words: "minute", "5 minutes".
func per(d time.Duration) string {
	if d == time.Minute {
		return "minute"
	}
	return fmt.Sprintf("%d minutes", int(d.Minutes()))
}
