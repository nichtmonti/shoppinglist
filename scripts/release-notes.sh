#!/bin/sh
# Prints a release's prose notes: its section of CHANGELOG.md, ready to sit
# above GoReleaser's commit list on the Codeberg release page
# (.woodpecker/release.yaml passes it as `--release-header`).
#
#   scripts/release-notes.sh v0.6.0 > /tmp/release-notes.md
#
# The section is the one headed `## v0.6.0: <title>`, up to the next `## `.
# Its title becomes the notes' heading, and links relative to the repo
# (`[decision log](docs/internals/decisions.md#…)`) are pointed at the tag's tree, since the
# release page is not in the repo. Each `[D-nn]` and `[§n]` keeps the link
# CHANGELOG.md defines for it at its end (scripts/decisions-index.mjs), pointed
# at the tag's tree too, so the text reads unchanged.
# A tag with no section is an error: every release tag sits on the commit that
# adds its entry (AGENTS.md, CHANGELOG.md).
#
# The repository's web URL is $RELEASE_REPO_URL if set, else Woodpecker's
# $CI_REPO_URL, else derived from `git remote get-url origin` (an ssh:// or
# scp-style remote becomes https://host/owner/repo).
#
# POSIX sh + awk: it runs in the goreleaser image, which has no bash.
set -eu

tag=${1:?usage: release-notes.sh vX.Y.Z}
here=$(dirname "$0")
changelog=${CHANGELOG:-$here/../CHANGELOG.md}
repo_url=${RELEASE_REPO_URL:-${CI_REPO_URL:-}}
if [ -z "$repo_url" ]; then
	# Its own step, so a failing git stops the script (sh has no pipefail).
	origin=$(git -C "$here" remote get-url origin)
	repo_url=$(echo "$origin" | sed -E \
		-e 's#^ssh://([^@/]+@)?([^/:]+)(:[0-9]+)?/#https://\2/#' \
		-e 's#^[^@/]+@([^:/]+):#https://\1/#' \
		-e 's#\.git$##')
fi
base="${repo_url%/}/src/tag/$tag/"

awk -v tag="$tag" -v base="$base" '
	# First pass: the link definitions at the end of the file.
	NR == FNR {
		if (match($0, /^\[(D-[0-9]+|§[0-9.]+)\]: /)) {
			def[substr($0, 2, RLENGTH - 4)] = substr($0, RLENGTH + 1)
		}
		next
	}
	# `## v0.6.0: title`, or a bare `## v0.6.0`.
	/^## / {
		if (found) exit
		version = $2
		sub(/:$/, "", version)
		if (version == tag) {
			found = 1
			title = $0
			sub(/^## [^ :]+(: )?/, "", title)
			if (title != "") print "## " title
		}
		next
	}
	found {
		# Blank lines are held back, so none trail the section.
		if ($0 == "") { blanks++; next }
		for (; blanks > 0; blanks--) print ""
		# Every citation gets its reference definition at the end.
		rest = $0
		while (match(rest, /\[(D-[0-9]+|§[0-9.]+)\]/)) {
			ref = substr(rest, RSTART + 1, RLENGTH - 2)
			if (!(ref in seen)) { seen[ref] = 1; refs[++nrefs] = ref }
			rest = substr(rest, RSTART + RLENGTH)
		}
		# Relative link targets → the tag tree; absolute URLs and #anchors stay.
		line = $0
		out = ""
		while (match(line, /\]\([^)#:][^):]*\)/)) {
			out = out substr(line, 1, RSTART + 1) base substr(line, RSTART + 2, RLENGTH - 2)
			line = substr(line, RSTART + RLENGTH)
		}
		print out line
	}
	END {
		if (!found) {
			print "release-notes: no `## " tag "` section in CHANGELOG.md" > "/dev/stderr"
			exit 1
		}
		if (nrefs) print ""
		for (i = 1; i <= nrefs; i++) {
			if (!(refs[i] in def)) {
				print "release-notes: CHANGELOG.md defines no link for [" refs[i] "]; run node scripts/decisions-index.mjs" > "/dev/stderr"
				exit 1
			}
			print "[" refs[i] "]: " base def[refs[i]]
		}
	}
' "$changelog" "$changelog"
