//go:build no_ui

package main

import (
	"io/fs"
	"testing"
)

// The no_ui build's whole contract ([D-64]): the tag buys an EMPTY filesystem,
// never a nil one. apis.Static panics on nil (apis/base.go:109) — the empty FS
// is what turns the SPA route into a 404 and sends security.loadCSP to its
// baseline, exactly as a missing build always behaved. A future edit that
// points this variant at real files, or leaves the var nil, would otherwise
// surface only as an e2e or runtime surprise — this pins it at unit level.
func TestPublicFS_EmptyUnderNoUI(t *testing.T) {
	if publicFS == nil {
		t.Fatal("publicFS is nil under -tags no_ui — apis.Static would panic while registering the static route")
	}

	if _, err := fs.ReadFile(publicFS, "index.html"); err == nil {
		t.Error("index.html is readable under -tags no_ui; this build is supposed to carry no SPA")
	}

	var files int
	err := fs.WalkDir(publicFS, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			files++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk the no_ui filesystem: %v", err)
	}
	if files != 0 {
		t.Errorf("the no_ui embed FS holds %d file(s); want 0", files)
	}
}
