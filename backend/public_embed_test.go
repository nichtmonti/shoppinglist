//go:build !no_ui

package main

import (
	"io/fs"
	"strings"
	"testing"
)

// Pins the compile shape of the real build ([D-64]). A bare `go build` already
// refuses an absent backend/pb_public, but nothing else checks that the
// embedded tree is rooted where the app reads it: publicFS comes from
// apis.MustSubFS(publicDir, "pb_public"), and a wrong subpath — or a copy step
// that nests the SPA one level too deep — compiles fine and serves 404s for
// everything, caught otherwise only at e2e, or in production.
func TestPublicFS_RootedAtSPA(t *testing.T) {
	if publicFS == nil {
		t.Fatal("publicFS is nil in the embed build")
	}

	raw, err := fs.ReadFile(publicFS, "index.html")
	if err != nil {
		t.Fatalf("index.html is not readable from the embedded FS: %v — "+
			"the SPA root is wrong (MustSubFS subpath or pb_public copy step)", err)
	}
	if len(raw) == 0 {
		t.Fatal("the embedded index.html is empty")
	}

	// SvelteKit's adapter-static shell starts with <!doctype html>. Only the
	// shape is asserted: security.loadCSP refuses an index.html without its
	// CSP meta tag, which internal/security pins.
	head := strings.ToLower(string(raw))
	if len(head) > 64 {
		head = head[:64]
	}
	if !strings.HasPrefix(strings.TrimSpace(head), "<!doctype") {
		t.Errorf("the embedded index.html does not start with <!doctype (got %q)", head)
	}
}
