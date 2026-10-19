#!/bin/sh
# Regenerates docs/THIRD_PARTY_LICENSES.md and docs/sbom.cdx.json; the work,
# and what it needs, is in third-party-licenses.mjs. This name stays the entry
# point because CI (.woodpecker/e2e.yaml) and the generated files cite it.
#
#   --check   compare with the committed files instead of writing them
set -eu
exec node "$(dirname "$0")/third-party-licenses.mjs" "$@"
