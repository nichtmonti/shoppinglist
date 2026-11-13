# Devcontainer — single source of truth for the development toolchain.
# Plain Dockerfile (not devcontainer "features") so `docker build`/`docker run`
# work headlessly as well as under VS Code / Codespaces. Every toolchain version
# is pinned exactly (docs/internals/design.md §14, "Every dependency is pinned to an exact version").
#
# Pins:  Go 1.27.4 · Node 26.13.0 · pnpm 12.17.0 (npm) · Playwright Chromium + Firefox (1.64.1)
# Go dev tools (staticcheck, gosec, osv-scanner, govulncheck, air, dex): tools/<name>/go.mod [D-75]
# diff-cover: tools/diff-cover/requirements.txt, hash-pinned [D-203]
# Binary/module name: `shoppinglist` (matches docs/internals/design.md [D-34] `./shoppinglist` CLI).
#
# Two stages ([D-203]). `toolchain` is everything that runs the code, as root:
# CI runs every step in it (localhost/shoppinglist-ci, built on the agent by
# .woodpecker/ci-image.yaml, its tag printed by scripts/ci-image-tag.sh). `dev`
# adds what a person or an agent working in the container needs on top, and is
# the stage devcontainer.json builds. One file, so CI and the devcontainer run
# the same toolchain. The base is pinned by digest: the release builds its SPA
# in this image, and a tag can be re-pushed.

FROM golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9 AS toolchain

# --- Base apt deps (xz-utils needed to unpack the Node tarball) ---------------
# python3-venv: diff-cover runs from a venv of its own, installed from
# tools/diff-cover/requirements.txt by the Taskfile ([D-203]).
RUN apt-get update \
    && apt-get install -y --no-install-recommends xz-utils jq ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# --- Node (exact patch) -------------------------------------------------------
# The golang base ships no Node; install the official linux-x64 tarball.
ARG NODE_VERSION=26.13.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version && npm --version

# --- pnpm 12.17.0, installed by npm (pinned) — Node 25+ ships no Corepack -----
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@12.17.0 && pnpm --version

# Ensure Go + pnpm are on PATH for *login* shells too (e.g. VS Code integrated
# terminal); the golang base image only sets ENV PATH, which login profiles reset.
RUN echo 'export PATH="/usr/local/go/bin:/go/bin:/usr/local/share/pnpm:$PATH"' > /etc/profile.d/devcontainer-path.sh

# Mark the bind-mounted repo as a safe directory for git. With the UID matched
# above this does not trigger; it guards a host whose UID is not 1000 and who
# forgets the --build-arg: "dubious ownership" otherwise breaks `go build` VCS
# stamping and any git command.
RUN git config --system --add safe.directory '*'

# --- Developer tooling: NOT installed here ------------------------------------
# The Go dev tools are pinned in tools/<name>/go.mod ([D-75]) and installed by
# .devcontainer/postCreate.sh (Dex is run through `go tool` instead): this
# image's build context is .devcontainer/, so the Dockerfile cannot COPY
# tools/<name>/go.mod, and a pin the build cannot read is a pin that drifts.
#
# The split:
#   image       language toolchains — Go, Node, pnpm, Playwright's browsers
#   postCreate  everything a manifest in the repo declares — backend/go.mod,
#               the root, frontend/ and e2e/ package.json files, and
#               tools/<name>/go.mod

# --- Playwright Chromium + Firefox (system deps + browsers for §14 E2E) -------
# The same version e2e/package.json pins (@playwright/test 1.64.1), so the dev
# container is ready to run E2E on first start. Firefox is for the tiles
# harness only [D-301]; every other harness runs Chromium.
# Installed to a SHARED path, not root's ~/.cache: the install needs root (apt
# --with-deps) but the browsers must be readable by `dev` at run time.
# A global install removed afterwards, not npx: Playwright warns about a missing
# project install whenever it runs from npx's cache.
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright
ARG PLAYWRIGHT_VERSION=1.64.1
RUN npm install -g --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium firefox \
    && npm uninstall -g playwright \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# =============================================================================
# The devcontainer: a person's or an agent's account on top of the toolchain.
FROM toolchain AS dev

# --- Non-root `dev` user, UID/GID-matched to the host -------------------------
# The repo is bind-mounted, and bind mounts carry raw numeric UIDs — there is no
# username translation. A container running as root therefore writes root-owned
# files onto the HOST, which then block `git commit` ("insufficient permission
# for adding an object to repository database") until someone chowns them back.
# Creating `dev` with the host's UID/GID (1000:1000 on a standard first Linux
# account) makes every file written from inside the container land as dev:dev on
# the host — the actual fix, rather than a repeated `sudo chown -R dev:dev .git`.
#
# Override at build time for a host whose UID differs:
#   docker build --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) ...
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid "$USER_GID" "$USERNAME" \
    && useradd --uid "$USER_UID" --gid "$USER_GID" --create-home --shell /bin/bash "$USERNAME" \
    && apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/"$USERNAME" \
    && chmod 0440 /etc/sudoers.d/"$USERNAME"

# --- Hand the toolchain's writable state to `dev` -----------------------------
# GOPATH (/go/pkg/mod for `go mod download`, /go/bin for `go install` — where
# postCreate.sh puts the tools/<name>/go.mod binaries) and the pnpm home are
# root-owned in the base image; without this the container starts as dev and
# every dependency step fails on EACCES.
RUN mkdir -p /go/pkg /go/bin "$PNPM_HOME" \
    && chown -R "$USER_UID:$USER_GID" /go "$PNPM_HOME"

# The parents of devcontainer.json's agent mounts (~/.cache/opencode,
# ~/.config/opencode, ~/.local/share/..., ~/.local/state/...), made here as
# `dev`: Docker creates a missing parent of a mount target as root, and a
# root-owned ~/.cache stops Go's build cache, pnpm and everything else that
# writes there.
RUN mkdir -p /home/dev/.cache /home/dev/.config /home/dev/.local/share /home/dev/.local/state /home/dev/.local/bin \
    && chown -R "$USER_UID:$USER_GID" /home/dev

# devcontainer.json mounts the repo at its host path and starts there; a
# headless `docker run` mounts it here.
WORKDIR /workspaces/shoppinglist

# Everything past this point — including `docker run`/`docker exec` with no
# --user flag, and VS Code's remoteUser — runs as dev, so files written into the
# bind mount are owned by the host's dev account.
USER dev
