#!/bin/sh
# Regenerate docs/THIRD_PARTY_LICENSES.md and docs/sbom.cdx.json after a
# Renovate dependency upgrade (postUpgradeTasks in renovate.json5, [D-356]),
# so the PR carries what CI's `task licenses -- --check` compares against.
#
# The runner's toolchain is not the repo's: GOTOOLCHAIN forces go.mod's
# pinned toolchain (third-party-licenses.mjs refuses any other Go, and the
# SBOM pins the stdlib to it), and pnpm runs at the Dockerfile's pin via npx.
# No standard tool reads those pins and regenerates the notice.
# POSIX sh, as ci-image-tag.sh; the runner allows exactly this command.
set -eu
cd "$(dirname "$0")/.."
GOTOOLCHAIN=$(sed -n 's/^toolchain //p' backend/go.mod)
export GOTOOLCHAIN
pnpm=$(sed -n 's/^RUN npm install -g pnpm@\([^ ]*\).*/\1/p' .devcontainer/Dockerfile)
echo "renovate-licenses: toolchain $GOTOOLCHAIN, pnpm $pnpm"
npx --yes "pnpm@$pnpm" -C frontend install --frozen-lockfile
node scripts/third-party-licenses.mjs