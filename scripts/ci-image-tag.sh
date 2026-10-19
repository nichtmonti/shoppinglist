#!/bin/sh
# The CI image's tag ([D-203]): the toolchain versions .devcontainer/Dockerfile
# pins, plus a hash of its `toolchain` stage, so any change to what CI runs on
# is a new tag and an old pipeline keeps the image it was tested on.
#
#   scripts/ci-image-tag.sh           print the tag
#   scripts/ci-image-tag.sh --image   print the image with its tag
#   scripts/ci-image-tag.sh --write   make every workflow name it (after a Dockerfile change)
#   scripts/ci-image-tag.sh --check   fail unless every workflow names it (CI)
#
# No standard tool does this: a content tag Woodpecker can read must be written
# into the workflow files, since an image name cannot be computed in a pipeline.
# POSIX sh: CI runs it in docker:cli (alpine). The image is built on the agent
# and never pushed ([D-203]); `localhost/` keeps a missing one from being
# pulled from a registry.
set -eu
cd "$(dirname "$0")/.."

IMAGE=localhost/shoppinglist-ci
f=.devcontainer/Dockerfile
stage=$(sed -n '/^FROM .* AS toolchain$/,/^FROM toolchain AS dev$/p' "$f" | grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' -e '^FROM toolchain AS dev$')
go=$(sed -n 's/^FROM golang:\([0-9.]*\)-.* AS toolchain$/\1/p' "$f")
node=$(sed -n 's/^ARG NODE_VERSION=//p' "$f")
pw=$(sed -n 's/^ARG PLAYWRIGHT_VERSION=//p' "$f")
hash=$(printf '%s\n' "$stage" | sha256sum | cut -c1-8)
tag="go$go-node$node-pw$pw-$hash"
[ -n "$go" ] && [ -n "$node" ] && [ -n "$pw" ] || {
	echo "ci-image-tag: cannot read the Go, Node or Playwright pin from $f" >&2
	exit 1
}

case "${1:-}" in
"") echo "$tag" ;;
--image) echo "$IMAGE:$tag" ;;
--write)
	sed -i "s#$IMAGE:[A-Za-z0-9._-]*#$IMAGE:$tag#g" .woodpecker/*.yaml
	echo "$tag"
	;;
--check)
	stale=$(grep -o "$IMAGE:[A-Za-z0-9._-]*" .woodpecker/*.yaml | grep -v ":$IMAGE:$tag\$" || true)
	if [ -n "$stale" ]; then
		echo "$stale" >&2
		echo "ci-image-tag: the workflows above do not name $IMAGE:$tag; run scripts/ci-image-tag.sh --write" >&2
		exit 1
	fi
	;;
*)
	sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
