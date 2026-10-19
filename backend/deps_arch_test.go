package main

import (
	"encoding/json"
	"maps"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestBinaryLinksNoTestDependencies is an architecture test ([D-154]): the
// shipped binary must not link test-only code. Tests may import anything —
// Dex runs beside the OIDC tests, internal/testutil boots throwaway apps — but
// one careless import from a production package would compile all of it into
// every deployment, and nothing else would notice: the binary still builds
// and every test still passes.
//
// It checks the dependency graph the go command resolves for this package,
// for every build — the shipped one with the SPA embedded, -tags no_ui, and
// the demo build ([D-234]) — against three rules:
//
//  1. Nothing outside the standard library imports the `testing` package.
//     Every test helper imports it, so this catches a helper pulled in by any
//     route, including ones that do not exist yet. (`testing` itself may be
//     linked: since Go 1.27, net/http/httptest imports it — see below.)
//  2. No in-repo test-support package is linked, by name — the same mistake,
//     with an error message that says which helper it was.
//  3. No tool pinned under tools/ is linked: Dex and every linter, scanner and
//     dev-loop supervisor there. The list comes from each tools/*/go.mod's
//     `tool` directives (via `go mod edit -json`), so a tool added later is
//     covered without touching this test.
//
// net/http/httptest IS linked, and legitimately: PocketBase's apis package
// uses its ResponseRecorder for internal requests and batch calls. A rule
// against "test-looking" standard packages would have to exempt it — and since
// Go 1.27 httptest imports `testing` itself, which is why rule 1 asks who
// imports `testing` rather than whether it is linked ([D-201]).
func TestBinaryLinksNoTestDependencies(t *testing.T) {
	testSupport := []string{
		"shoppinglist/internal/testutil",
		"shoppinglist/internal/testutil/testapp",
		"shoppinglist/internal/dextest",
		"shoppinglist/internal/sectest",
	}
	tools := pinnedToolModules(t)
	if len(tools) == 0 {
		t.Fatal("found no tool modules under ../tools — the test would check nothing")
	}
	t.Logf("tool modules that must not be linked: %v", tools)

	for _, tags := range []string{"", "no_ui", "demo", "demo,no_ui"} {
		for _, dep := range deps(t, tags) {
			switch {
			case dep.Module != "" && slices.Contains(dep.Imports, "testing"):
				t.Errorf("[tags %q] %s imports the testing package into the binary", tags, dep.ImportPath)
			case slices.Contains(testSupport, dep.ImportPath):
				t.Errorf("[tags %q] the binary links test-support package %s", tags, dep.ImportPath)
			case dep.Module != "" && slices.Contains(tools, dep.Module):
				t.Errorf("[tags %q] the binary links %s from %s, a tool pinned under tools/",
					tags, dep.ImportPath, dep.Module)
			}
		}
	}
}

// TestOnlyTheDemoBuildLinksTheDemo is the demo build's half of the same idea
// ([D-234]): its password-free sign-in exists only in a binary built with
// -tags demo. A normal binary that linked internal/demo would not yet serve
// its route — demo_off.go registers nothing — but one stray import would be
// all it took. The demo builds must link it, which shows the check can see it.
func TestOnlyTheDemoBuildLinksTheDemo(t *testing.T) {
	const pkg = "shoppinglist/internal/demo"
	for _, tc := range []struct {
		tags string
		want bool
	}{{"", false}, {"no_ui", false}, {"demo", true}, {"demo,no_ui", true}} {
		linked := slices.ContainsFunc(deps(t, tc.tags), func(d dependency) bool { return d.ImportPath == pkg })
		if linked != tc.want {
			t.Errorf("[tags %q] links %s: %v, want %v", tc.tags, pkg, linked, tc.want)
		}
	}
}

// TestInternalLayering holds the in-repo import graph to a table. The base
// packages hold no feature of their own and import only each other, so any
// package may use them. Every other package is listed with the only other
// in-repo packages it may import: an edge between two features (the core sync
// package importing the barcode feature, say) is then a line changed here,
// not an accident. A new package fails until it is placed, and an entry for a
// package the binary no longer links fails until it is removed. Package main
// is the composition root and may import anything.
func TestInternalLayering(t *testing.T) {
	base := []string{
		"applog", "envflag", "fieldcontract", "listcap", "members", "normalize", "oidclogin",
		"randid", "ratelimit", "records", "security", "seed/candidates", "tombstone",
	}
	features := map[string][]string{
		"account": nil, "barcode": nil, "bootenv": nil, "clienterrors": nil, "curate": nil,
		"health": nil, "invites": nil, "migrations": nil, "oidc": nil, "seed": nil, "sync": nil, "ui": nil,
		"demo":          {"account", "barcode"},
		"jobs":          {"account", "barcode", "invites", "sync", "webauthn"},
		"lists":         {"invites", "sync"},
		"signup":        {"invites"},
		"upgradebackup": {"seed"},
		"webauthn":      {"bootenv", "signup"},
	}
	name := func(path string) (string, bool) {
		rest, ok := strings.CutPrefix(path, "shoppinglist/")
		return strings.TrimPrefix(rest, "internal/"), ok
	}
	linked := map[string]bool{}
	// The demo build without the SPA links every package the others do.
	for _, dep := range deps(t, "demo,no_ui") {
		pkg, ok := name(dep.ImportPath)
		if !ok {
			continue // the standard library, PocketBase, package main
		}
		linked[pkg] = true
		allowed, isFeature := features[pkg]
		if !isFeature && !slices.Contains(base, pkg) {
			t.Errorf("%s is in neither table: place it", pkg)
			continue
		}
		for _, imp := range dep.Imports {
			if dst, ok := name(imp); ok && !slices.Contains(base, dst) && !slices.Contains(allowed, dst) {
				t.Errorf("%s imports %s, which its row does not allow", pkg, dst)
			}
		}
	}
	for _, pkg := range append(slices.Collect(maps.Keys(features)), base...) {
		if !linked[pkg] {
			t.Errorf("%s is in the table but not in the binary: remove it", pkg)
		}
	}
}

type dependency struct {
	ImportPath string
	Module     string // "" for the standard library
	Imports    []string
}

// deps lists every package the binary links under `tags`, with its module.
func deps(t *testing.T, tags string) []dependency {
	t.Helper()
	// -e: without a built SPA (CI's Go step, a fresh checkout) the embed
	// build's `all:pb_public` pattern matches no files. That is an error about
	// embedded FILES, not imports, so the dependency graph listed is complete.
	// #nosec G204 -- fixed go-command arguments; tags come from the table above.
	out, err := exec.Command("go", "list", "-e", "-tags", tags, "-deps",
		"-f", "{{.ImportPath}}\t{{if .Module}}{{.Module.Path}}{{end}}\t{{join .Imports \",\"}}", ".").Output()
	if err != nil {
		t.Fatalf("go list -deps (tags %q): %v", tags, stderrOf(err))
	}
	var list []dependency
	for line := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
		path, rest, _ := strings.Cut(line, "\t")
		mod, imports, _ := strings.Cut(rest, "\t")
		list = append(list, dependency{ImportPath: path, Module: mod, Imports: strings.Split(imports, ",")})
	}
	return list
}

// pinnedToolModules returns the module providing each `tool` directive in
// every ../tools/*/go.mod — the tool's own module, not its dependencies,
// which may legitimately overlap with the app's.
func pinnedToolModules(t *testing.T) []string {
	t.Helper()
	dirs, err := filepath.Glob(filepath.Join("..", "tools", "*", "go.mod"))
	if err != nil {
		t.Fatalf("glob tools: %v", err)
	}
	var modules []string
	for _, gomod := range dirs {
		// #nosec G204 -- the go command on this repository's own go.mod files.
		out, err := exec.Command("go", "mod", "edit", "-json", gomod).Output()
		if err != nil {
			t.Fatalf("go mod edit -json %s: %v", gomod, stderrOf(err))
		}
		var mod struct {
			Require []struct{ Path string }
			Tool    []struct{ Path string }
		}
		if err := json.Unmarshal(out, &mod); err != nil {
			t.Fatalf("decode %s: %v", gomod, err)
		}
		for _, tool := range mod.Tool {
			if m := providingModule(tool.Path, mod.Require); m != "" {
				modules = append(modules, m)
			} else {
				t.Errorf("%s: no require provides tool %s", gomod, tool.Path)
			}
		}
	}
	return modules
}

// providingModule is the longest required module path that `pkg` lives in.
func providingModule(pkg string, requires []struct{ Path string }) string {
	best := ""
	for _, r := range requires {
		if (pkg == r.Path || strings.HasPrefix(pkg, r.Path+"/")) && len(r.Path) > len(best) {
			best = r.Path
		}
	}
	return best
}

func stderrOf(err error) string {
	if ee, ok := err.(*exec.ExitError); ok {
		return err.Error() + ": " + string(ee.Stderr)
	}
	return err.Error()
}
