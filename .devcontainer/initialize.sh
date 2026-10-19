#!/usr/bin/env bash
# Runs on the HOST before the devcontainer is created (initializeCommand).
# devcontainer.json bind-mounts the coding agents' directories from the host
# account, and a bind mount whose source is missing stops the container from
# starting. So every source is created here, empty if that tool is not
# installed: the container then starts for anyone, and an agent installed later
# shows up after a rebuild.
set -euo pipefail
for d in .claude .local/share/claude .local/bin .omp .opencode .config/opencode \
	.local/share/opencode .local/state/opencode .cache/opencode .ssh; do
	mkdir -p "$HOME/$d"
done
