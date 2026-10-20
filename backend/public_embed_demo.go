//go:build demo && !no_ui

package main

import (
	"embed"
	"io/fs"

	"github.com/pocketbase/pocketbase/apis"
)

// The demo build's SPA ([D-234]): public_embed.go's twin, reading
// backend/pb_public_demo (`task build-demo`), a directory of its own so a
// normal `go build` can never embed the demo SPA.
//
//go:embed all:pb_public_demo
var publicDir embed.FS

var publicFS fs.FS = apis.MustSubFS(publicDir, "pb_public_demo")
