// Package docblock holds the parts of the docs that code knows to that code
// ([D-337]): a block between two markers is what a test renders from it, and
// `go test <package> -update` rewrites the block. It imports only the
// standard library, so any package's own tests can use it.
//
// A test that reads a file outside backend/ is named TestDocs…: Go's test
// cache does not see such a file, so the gate's go-test layer runs those
// tests again uncached (Taskfile.yml).
package docblock

import (
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the rendered blocks in the docs")

// section is a bare §n, which the docs write [§n] so that it links
// (scripts/decisions-index.mjs); code comments keep it bare.
var section = regexp.MustCompile(`(^|[^\[])§(\d+(?:\.\d+)*)`)

// Render holds every block named name in the repository file path to what
// render returns for it. A block is
//
//	<!-- name[: args] (rendered from <source> by its test) -->
//	…
//	<!-- name end -->
//
// and render gets the words after the colon; a §n in what it returns is
// written [§n], as the docs cite it. A stale block fails the test, or with
// -update is rewritten; a file without one fails it either way.
func Render(t *testing.T, path, name string, render func(args []string) string) {
	t.Helper()
	root, pkg := repo(t)
	raw, err := root.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	q := regexp.QuoteMeta(name)
	block := regexp.MustCompile(`(?s)<!-- ` + q + `(?:: ([^(]*?))? \(rendered from [^)]*\) -->\n(.*?)<!-- ` + q + ` end -->`)
	blocks := block.FindAllStringSubmatchIndex(string(raw), -1)
	if len(blocks) == 0 {
		t.Fatalf("%s has no %q block", path, name)
	}
	var out strings.Builder
	last := 0
	for _, b := range blocks {
		var args []string
		if b[2] >= 0 {
			args = strings.Fields(string(raw[b[2]:b[3]]))
		}
		out.Write(raw[last:b[4]])
		out.WriteString(section.ReplaceAllString(render(args), "${1}[§${2}]"))
		last = b[5]
	}
	out.Write(raw[last:])
	switch {
	case out.String() == string(raw):
	case *update:
		if err := root.WriteFile(path, []byte(out.String()), 0o600); err != nil {
			t.Fatal(err)
		}
	default:
		t.Errorf("the %q block in %s is stale: go test ./%s -update", name, path, pkg)
	}
}

// Read is the repository file path, its whitespace runs folded to one space,
// so a phrase matches across a wrapped line.
func Read(t *testing.T, path string) string {
	t.Helper()
	root, _ := repo(t)
	raw, err := root.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(strings.Fields(string(raw)), " ")
}

// repo is the repository's root, the parent of the go.mod above the test's
// package, and the package's path below that go.mod.
func repo(t *testing.T) (root *os.Root, pkg string) {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := wd
	for ; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			break
		}
		if dir == filepath.Dir(dir) {
			t.Fatalf("no go.mod above %s", wd)
		}
	}
	pkg, err = filepath.Rel(dir, wd)
	if err != nil {
		t.Fatal(err)
	}
	root, err = os.OpenRoot(filepath.Dir(dir))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return root, filepath.ToSlash(pkg)
}
