//go:build no_ui

package main

import (
	"embed"
	"io/fs"
)

// The no-frontend build ([D-64]) for `go vet`, `go test` and scripts/dev.sh,
// which never run `pnpm build`. A zero embed.FS, not nil: apis.Static panics
// on a nil fs.FS, while an empty one makes the shell 404 and security.loadCSP
// fall back to its baseline policy.
var publicFS fs.FS = embed.FS{}
