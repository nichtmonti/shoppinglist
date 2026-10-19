#!/bin/sh
# Builds the demo binary, backend/shoppinglist-demo ([D-234]): the SPA with
# SHOPPINGLIST_DEMO_BUILD=1, embedded by `go build -tags demo`. Its SPA lives
# in frontend/build-demo and backend/pb_public_demo, so a normal build next to
# it is unaffected. Run the result as docs/internals/demo.md describes.
#
# POSIX sh, like build-embedded-spa.sh.
set -eu
cd "$(dirname "$0")/.." # repo root

SHOPPINGLIST_DEMO_BUILD=1 scripts/build-embedded-spa.sh
# CGO off and the target overridable, as the releases are built
# (.goreleaser.yaml): one static file to copy to the demo's server, e.g.
# GOARCH=arm64 scripts/build-demo.sh for a Raspberry Pi. -cover when
# GOCOVERDIR is set, as the Taskfile's other builds ([D-203]).
(cd backend && CGO_ENABLED=0 go build ${GOCOVERDIR:+-cover} -tags demo -o shoppinglist-demo .)
