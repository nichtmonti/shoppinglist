package jobs

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"shoppinglist/internal/testutil/docblock"
)

// [D-337] The job tables in docs/operating.md and design.md §13 are the jobs
// table: its comments say what each job does, with its window in words.
func TestDocsJobTables(t *testing.T) {
	docs := jobComments(t)
	docblock.Render(t, "docs/operating.md", "cron jobs", func([]string) string {
		var b strings.Builder
		b.WriteString("| Job | Schedule | What it does |\n|---|---|---|\n")
		for _, j := range jobs {
			if docs[j.name] == "" {
				t.Errorf("%s has no comment: the table would say nothing", j.name)
			}
			what := strings.ReplaceAll(docs[j.name], "{window}", inWords(j.window))
			fmt.Fprintf(&b, "| `%s` | %s | %s |\n", j.name, schedule(t, j.schedule), what)
		}
		return b.String()
	})
	docblock.Render(t, "docs/internals/design.md", "cron jobs", func([]string) string {
		var b strings.Builder
		b.WriteString("| Job | Schedule | Window | Sweep |\n|---|---|---|---|\n")
		for _, j := range jobs {
			sweep := path.Base(runtime.FuncForPC(reflect.ValueOf(j.sweep).Pointer()).Name())
			fmt.Fprintf(&b, "| `%s` | %s | %s | `%s` |\n", j.name, schedule(t, j.schedule), inWords(j.window), sweep)
		}
		return b.String()
	})
}

// schedule is a cron expression as the tables say it.
func schedule(t *testing.T, expr string) string {
	words, ok := map[string]string{daily: "daily, 03:00 UTC", "*/15 * * * *": "every 15 minutes"}[expr]
	if !ok {
		t.Errorf("schedule %q has no words for the docs", expr)
	}
	return words
}

// inWords is a window in whole days, or hours where it is not.
func inWords(d time.Duration) string {
	if d%(24*time.Hour) == 0 {
		return fmt.Sprintf("%d days", int(d.Hours()/24))
	}
	return fmt.Sprintf("%d hours", int(d.Hours()))
}

// jobComments is the comment above each entry of jobs in jobs.go, by name.
func jobComments(t *testing.T) map[string]string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "jobs.go", nil, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	above := map[int]string{} // the line after a comment ends: its text
	for _, c := range file.Comments {
		above[fset.Position(c.End()).Line+1] = strings.Join(strings.Fields(c.Text()), " ")
	}
	docs := map[string]string{}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok || spec.Names[0].Name != "jobs" {
			return true
		}
		for _, elt := range spec.Values[0].(*ast.CompositeLit).Elts {
			name, err := strconv.Unquote(elt.(*ast.CompositeLit).Elts[0].(*ast.BasicLit).Value)
			if err != nil {
				t.Fatal(err)
			}
			docs[name] = above[fset.Position(elt.Pos()).Line]
		}
		return false
	})
	return docs
}
