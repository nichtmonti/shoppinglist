//go:build !no_ui && !demo

package main

import (
	"embed"
	"io/fs"

	"github.com/pocketbase/pocketbase/apis"
)

// The SvelteKit SPA, compiled into the binary ([D-64]). backend/pb_public is
// a gitignored build input from `task build-spa`; without it the
// build fails, so commands that do not need the SPA use `-tags no_ui`
// (public_noui.go).
//
//go:embed all:pb_public
var publicDir embed.FS

var publicFS fs.FS = apis.MustSubFS(publicDir, "pb_public")
