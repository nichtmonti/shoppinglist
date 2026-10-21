#!/usr/bin/env bash
# Idempotent dev-environment hydration, run on every container create: the Go
# modules, the pinned Go dev tools and the three pnpm projects. Installs from
# the committed lockfiles, as CI does (docs/internals/design.md §14).
set -euo pipefail

if [ -f backend/go.mod ]; then
  echo ">> go mod download"
  (cd backend && go mod download)
fi

# The pinned dev tools ([D-75]). One module PER TOOL under tools/, and that is
# not tidiness: `tool` directives in one module make Go pick a single
# dependency resolution across all of them, which can select a dependency
# version one tool does not compile against. A module each resolves every tool
# as its own `go install pkg@version` would.
#
# Dex (tools/dex) is not installed: scripts/dev.sh and the OIDC harness run it
# through `go -C tools/dex tool dex`.
#
# No @version anywhere: `go install` inside a module builds the version that
# module pins, which is the entire point of moving these out of shell arguments.
# GOBIN is /go/bin, already on PATH and already chowned to `dev` by the image.
#
# This is why the image alone is not a complete dev environment (see
# .devcontainer/Dockerfile).
for dir in tools/*/; do
  dir="${dir%/}"
  [ "$dir" = tools/dex ] && continue
  if [ -f "$dir/go.mod" ]; then
    echo ">> go install ($dir)"
    go -C "$dir" install tool
  fi
done

# The three pnpm projects (the root's prettier, frontend, e2e), installed as
# the gate installs them: from the committed lockfiles, which a plain
# `pnpm install` could rewrite.
echo ">> task deps"
task deps

# [D-274] gitleaks before every push: the repo's hooks live in .githooks/.
# The checkout's git config is shared with the host, so this enables the hook
# for pushes from either side.
echo ">> git hooks (.githooks)"
git config core.hooksPath .githooks

echo ">> devcontainer ready"
