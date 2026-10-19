package sync

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The §8.5 digest is sha256 over each list's sorted `{id}:{updated}` pairs, so
// it can only ever detect a change that `updated` reflects. `updated` is
// stamped by PocketBase's autodate ON SAVE — SQLite does not maintain it — so
// the guarantee holds automatically for the record pipeline and NOT AT ALL for
// raw SQL.
//
// That asymmetry has exactly one dangerous shape:
//
//	DELETE  the id leaves the set        → hash + row count move on their own
//	INSERT  the id enters the set        → same
//	UPDATE  nothing structural changes   → detectable ONLY if `updated` moves
//
// A raw UPDATE against a digested collection that forgets `updated = <now>`
// therefore mutates rows while leaving every client's digest byte-identical.
// Nobody re-pulls, because the repair only runs on a mismatch — so every
// replica agrees it is in sync while showing data the server no longer has.
// It never heals: there is no later cycle that notices.
//
// This test is the structural guard for that class. TestClearHistoryMovesTheDigest
// (internal/lists) pins the one site that exists today; this pins every site
// that will ever exist, including ones nobody has written yet.
//
// The scope is DERIVED from digest.go rather than hardcoded, so adding a third
// collection to the digest automatically extends the rule to it — a guard that
// needs manual widening is a guard that silently stops covering things.
func TestNoSilentDivergenceFromRawSQL(t *testing.T) {
	root := backendRoot(t)

	digested := digestedCollections(t, root)
	if len(digested) < 2 {
		t.Fatalf("parsed %v from digest.go — expected at least items and list_categories; "+
			"the parse below has drifted and this guard is no longer covering anything", digested)
	}
	t.Logf("digested collections (derived from internal/sync/digest.go): %v", digested)

	// One alternation over every digested table, e.g. `UPDATE items` /
	// "UPDATE  `list_categories`". Backticks and quoting are tolerated because
	// SQL allows them and a future author may well use them.
	names := make([]string, 0, len(digested))
	for _, c := range digested {
		names = append(names, regexp.QuoteMeta(c))
	}
	updateRe := regexp.MustCompile(`(?is)\bUPDATE\s+[` + "`" + `"']?(` + strings.Join(names, "|") + `)[` + "`" + `"']?\b`)
	setsUpdatedRe := regexp.MustCompile(`(?is)\bupdated\s*=`)

	var offenders []string

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == "pb_data" || info.Name() == "pb_public" || info.Name() == "tmp" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return perr
		}

		// String LITERALS, not raw file text: a comment mentioning
		// "UPDATE items" must not trip the guard, and this file is full of them.
		//
		// Concatenation is flattened FIRST. internal/jobs/jobs.go already builds
		// a statement as `"DELETE FROM invites " + "WHERE ..."`, so matching one
		// literal at a time would read `"UPDATE items "` as a whole statement and
		// report a missing `updated` that the very next fragment supplies —
		// flagging correct code, which is how a guard earns being ignored.
		check := func(sql string, pos token.Pos) {
			m := updateRe.FindStringSubmatch(sql)
			if m == nil || setsUpdatedRe.MatchString(sql) {
				return
			}
			rel, _ := filepath.Rel(root, path)
			offenders = append(offenders, rel+":"+strconv.Itoa(fset.Position(pos).Line)+
				" — UPDATE against "+m[1]+" without setting `updated`")
		}

		ast.Inspect(file, func(n ast.Node) bool {
			switch e := n.(type) {
			case *ast.BinaryExpr:
				// A whole `"a" + "b" + "c"` chain is one statement. Returning
				// false stops the walk descending into its parts, so the
				// fragments are never also judged on their own.
				if sql, ok := flattenConcat(e); ok {
					check(sql, e.Pos())
					return false
				}
			case *ast.BasicLit:
				if e.Kind == token.STRING {
					if sql, uerr := strconv.Unquote(e.Value); uerr == nil {
						check(sql, e.Pos())
					}
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(offenders) > 0 {
		t.Errorf("raw UPDATE against a digested collection that does not set `updated`:\n  %s\n\n"+
			"The §8.5 digest hashes {id}:{updated} pairs, and `updated` is stamped by PocketBase on\n"+
			"save — not by SQLite. An UPDATE that leaves it alone changes the data while every\n"+
			"client's digest stays identical, so nobody ever re-pulls and the divergence is\n"+
			"PERMANENT. Add `updated = {:now}` (bind types.NowDateTime().String()), or go through\n"+
			"the record pipeline instead. See internal/lists/clearhistory.go for the worked example.",
			strings.Join(offenders, "\n  "))
	}
}

// backendRoot returns the backend/ directory; tests run with cwd set to their
// own package directory (internal/sync), so the root is two levels up.
func backendRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root, err := filepath.Abs(filepath.Join(wd, "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("backend root %q has no go.mod — the layout moved and this guard cannot locate the tree", root)
	}
	return root
}

// digestedCollections reads the table names digestHandler actually hashes out
// of digest.go's own queries, so the rule's scope tracks the digest instead of
// restating it.
func digestedCollections(t *testing.T, root string) []string {
	t.Helper()
	path := filepath.Join(root, "internal", "sync", "digest.go")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read digest.go: %v", err)
	}
	re := regexp.MustCompile(`(?i)SELECT\s+id,\s*updated\s+FROM\s+(\w+)`)
	seen := map[string]bool{}
	var out []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// flattenConcat joins a `"a" + "b" + "c"` chain of string literals into the one
// string it denotes, reporting false if any operand is not a literal (a
// variable, a fmt.Sprintf, anything this test cannot evaluate). A statement
// assembled from a non-literal is outside what static inspection can judge; the
// behavioural guard in internal/lists is the backstop for those.
func flattenConcat(e *ast.BinaryExpr) (string, bool) {
	if e.Op != token.ADD {
		return "", false
	}
	var walk func(ast.Expr) (string, bool)
	walk = func(n ast.Expr) (string, bool) {
		switch x := n.(type) {
		case *ast.BasicLit:
			if x.Kind != token.STRING {
				return "", false
			}
			s, err := strconv.Unquote(x.Value)
			return s, err == nil
		case *ast.BinaryExpr:
			if x.Op != token.ADD {
				return "", false
			}
			l, ok := walk(x.X)
			if !ok {
				return "", false
			}
			r, ok := walk(x.Y)
			if !ok {
				return "", false
			}
			return l + r, true
		case *ast.ParenExpr:
			return walk(x.X)
		}
		return "", false
	}
	return walk(e)
}
