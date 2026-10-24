# Notes for coding agents

This file is for what an agent gets wrong that a human does not. Orientation
is elsewhere: [`docs/internals/design.md`](docs/internals/design.md) is the
spec (every `§`/`[D-nn]` in the code points into it),
[`docs/internals/decisions.md`](docs/internals/decisions.md) says why,
[`docs/internals/impl-notes.md`](docs/internals/impl-notes.md) covers the test
layers, [`CHANGELOG.md`](CHANGELOG.md) what each release shipped, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) is the short human version of this file.

**Human-facing docs stay short.** `README.md`, `CONTRIBUTING.md`,
`SECURITY.md`, `docs/using.md`, `docs/deploying.md` and `docs/operating.md`
are read by visitors, users and operators: keep them compact, and put an
operator's full detail in `docs/deploy-reference.md` only. The operator pages,
`.env.example` and `docker-compose.yml` carry no `[D-nn]`, no `§` and no
history; cite decisions in code and in `docs/internals/`. **A fact lives in one
place and the others link to it**: before adding a sentence to a doc or a
comment, check whether it is already said elsewhere.

**Links are checked the way Codeberg renders them** (`node
scripts/doc-links.mjs`, in CI): a heading anchor turns every run of
punctuation into one dash, so keep a linked heading free of punctuation. It
also checks every `<img src>`, a `docs/…md#anchor` cited from code, config or
a log message, a repo path, task or `pnpm` script a doc names in backticks,
and every `§` cited (its header lists the rules).

**A new setting is declared once, in `backend/internal/settings/settings.go`**
([D-337]): a field with its name and default as tags and its description as
its doc comment, plus its name constant. Then `go test ./internal/settings
-update` renders it into `docs/deploy-reference.md`, and `.env.example` offers
it (set or commented out, with what it does). The package's tests fail on
anything left out. A new `SHOPPINGLIST_` variable for tooling goes in that
file's `toolingNames`, or the server refuses to start while it is set
([D-336]). `docker-compose.yml` hands `.env` over whole
(`env_file`), so it never names a setting. A name `.env.example` offers must
be one the server or compose reads. The demo build's settings are exempt from
`.env.example`, not from the docs.

**A commit that changes what a user or an operator sees adds its entry under
`CHANGELOG.md`'s `## Unreleased`, in the same commit**: a feature, a
noticeable fix, a new, renamed or removed setting, a database change, a change
to the human-facing docs. Not refactors, tests, CI or harnesses. Plain language,
the UI's own English strings (`en.json`, in "…"), the `[D-nn]`, and anything
an operator must do before upgrading at the top. Before committing, compare
`git log $(git describe --tags --abbrev=0)..HEAD` with the section. A release
tag sits on the commit that renames the heading (`docs(release): vX.Y.Z change
history`), and `scripts/release-notes.sh` fails a tag without an entry.

**After adding or retitling a `[D-nn]` entry, or citing one or a `§n` in
Markdown, run `node scripts/decisions-index.mjs`**: it rewrites the index and
makes each citation a link (a bracketed `[§n]`, and the definitions at the
file's end). CI fails a stale index or link, and a citation of an entry the
log does not have. The log says what holds, not how it got
there: the rule, why, and what was rejected, about 200 words. A decision
replaced completely is deleted, and every citation of it, CHANGELOG
included, moves to what replaced it; one replaced in part is rewritten to
what still holds, with one sentence "Its … was (were) replaced by [D-nn]: …"
in place of the rest. Never renumber an entry or reuse a number.

## Run the tests inside the devcontainer

**A change of behaviour brings its test**, under
[CONTRIBUTING's policy](CONTRIBUTING.md#test): a feature its tests, a fix one
that fails without it.

**Everything below runs inside the devcontainer**, where Go, node, pnpm and
Playwright's Chromium and Firefox are (`echo $SHOPPINGLIST_DEVCONTAINER` prints `1`). The
host has no Go toolchain, and `gate.sh` and `shots.sh` refuse to start there.
From the host, `scripts/agent.sh [claude|omp|opencode]` starts an agent inside
it ([D-252]) in the directory it is called from, checkout or worktree, and
starts the container from the main checkout when none runs (see "One container
per checkout"). The repo is at the same path as on the host, worktrees
included.

### The gate

**`scripts/gate.sh` is the commit gate, and it runs no browser
([D-177]).** It runs `task` (`Taskfile.yml`, go-task from `tools/task`) and
takes the same arguments. A layer whose inputs have not changed since it last
passed is skipped and the rest scope themselves to the diff, so a rerun
repeats only what failed; a few minutes at most. Its layers, what each runs
and its port are in [impl-notes](docs/internals/impl-notes.md#test-layers).

- **Browser specs run when you name them:** `scripts/gate.sh e2e:functional
  -- tests/conflicts.spec.ts`, or `e2e:arch` (`tiles`, `oidc`, `demo`) for a
  whole harness; Playwright's own arguments go after `--` (`-g`,
  `--last-failed`). Name the spec that covers what you changed. CI runs every
  harness on every push ([D-177]), so the full matrix is not your commit
  gate's job.
- **`scripts/gate.sh full` is for a release or a toolchain bump**: every
  non-browser layer at full scope. `scripts/gate.sh e2e` runs every harness in
  two lanes. The changed-file layers check everything not yet on
  `origin/main`, committed or not, on any branch; `SINCE=<ref>` picks another
  base.
- **One gate runs at a time on the machine**, in any checkout or worktree, and
  every harness and `scripts/shots.sh` take the same lock
  (`scripts/lib/lock.sh`). A second run waits and names the holder. Do not
  work around the wait: two browser phases at once do not fit in the box's
  8 GB.
- **It exits nonzero when a layer failed**, and its last line names every
  failed layer (go-task alone names the first). A layer whose dependency
  failed does not run: a failed build leaves no stale binary to test. The
  output is also in `logs/gate-<stamp>.log` (`logs/latest.log`). Stop it with
  Ctrl-C or a TERM to `gate.sh`; a TERM to `task` itself is ignored and
  leaves its commands running.

**While writing code, use vitest's watch mode**, not the gate: `cd frontend &&
pnpm test:client [pattern]` (component tests) or `pnpm test:unit` (+ server
project). A warm re-run is ~2s where a cold one is minutes, because each new
process pays the transform of the module graph again.

### Running a layer by hand

From the checkout's root:

```sh
pnpm format:check
(cd backend && go test -tags no_ui ./...)
(cd backend && staticcheck -tags no_ui ./... && gosec -tags no_ui ./... && golangci-lint run ./...)
(cd frontend && pnpm lint && pnpm check && pnpm exec knip)
(cd e2e && pnpm check && pnpm lint)
(cd frontend && npx vitest run)
task build-app   # the binary the two below serve
(cd e2e && E2E_PORT=8097 npx playwright test)
(cd e2e && E2E_PORT=8096 npx playwright test -c arch/arch.config.ts)
```

- `npx vitest run` adds the `integration` project (two Dexie clients against a
  real binary, the suite with teeth on the sync engine); `pnpm test` runs only
  `server` and `client`.
- **`npx vitest related <files> --run`, never `vitest run related <files>`**,
  which reads the words after `run` as filename filters and passes on zero
  tests. A change under `frontend/messages/` needs the whole suite, since
  `related` and `--changed` cannot trace generated Paraglide output
  (`forceRerunTriggers` in `vite.config.ts` makes `--changed` run it all).
- **Lint through `frontend/scripts/lint.js` (`pnpm lint`), never one `eslint`
  over everything:** it runs components and the rest as two processes, 70
  seconds against 27 minutes ([D-243]). Changed-file lint is exact for the
  files you touched; `gate.sh full` and CI lint the whole project without a cache,
  which typescript-eslint calls unsound for typed rules. `pnpm lint:fast` is
  for editors; the shared rules live in `eslint.shared.config.js`.
- **Formatting is repo-wide, from the root:** `pnpm format` / `pnpm
  format:check`, never a bare `npx prettier` in a subdirectory (it resolves
  config upward and would apply defaults). YAML, Markdown and
  `backend/seed/*.json` are deliberately unformatted (`.prettierignore`).
- The gate builds the backend when its sources changed
  (`backend/shoppinglist` with the real SPA for a browser harness,
  `backend/shoppinglist-no-ui` for the integration project) and hands it to
  the layers as `SHOPPINGLIST_BIN`. Do not point that at a stale binary by
  hand.
- **The changed lines no test reaches** ([D-203]): `task coverage:go`, or
  `task vitest:all -- --coverage` then `task coverage:frontend`; what is not
  yet on `origin/main`, or everything since `SINCE=<ref>` in the
  environment. A listed line
  is a prompt to look, not a number to raise.
- Vitest caches transformed modules in `node_modules/.vitest-cache` ([D-177]);
  `npx vitest --clearCache` clears it. A plugin serving a module with no file
  behind it must key it itself (see `vite-plugin-openmoji.ts`).

### The harnesses

Each has its own config, port and server; a bare `npx playwright test` runs
only the functional suite. Run one through the gate (`scripts/gate.sh
e2e:<name>`) or by hand as below.

- **Functional, `e2e/tests/`**, 8097, plus an invite-only server on 8089 for
  `invite-signup.spec.ts` ([D-241]).
- **Arch, `e2e/arch/`** ([D-124]), 8096, single worker: presses every visible
  control on every surface and fails unless something observable changes. Its
  own server because its request burst trips PocketBase's per-IP rule beside
  the functional suite.
- **OIDC, `e2e/oidc/`** ([D-154]), 8095 against Dex on 5557, plus an
  OIDC-only server on 8094 ([D-76]). Each journey sends its own
  `X-Forwarded-For` (2 sign-ins per 3s per IP), and after signing in the app
  stays on its route, so go home explicitly.
- **Tiles, `e2e/tiles/`** ([D-166], [D-228]), the Vite dev server on 8093 with
  no backend: the tile audit and the state audit (axe, 44px targets, every
  picture drawn) over the gallery, in Chromium and Firefox ([D-301]). Run it
  after a change to `ShopTile`, the list rows, `app.css` or any layout.
  Open states with `openGallery(page, {...})` and find items by
  `[data-item="<case id>"]`; never drive the toolbar. Vite is started with
  `node`, not `pnpm exec`, whose process group hung every run.
- **Demo, `e2e/demo/`** ([D-234]), 8088, its own binary from `task
  build-demo`.
- **Upgrade, `e2e/upgrade/`** ([D-343]), 8085: the previous release's server
  and page, then this build's on the same port and data; then that release's
  `integration` project against this server on 8084, from a worktree of the
  previous tag under `~/.cache/shoppinglist-prev` (the host's `git worktree
  list` shows it as prunable; never prune from the container). Until the
  reload the page is the previous build's, so those steps say its own words
  (`previousCopy()`, by message key). A variable of the harness's own is
  `E2E_`-named: the previous release refuses a `SHOPPINGLIST_` name it does
  not know ([D-336]).

**A wait names a state its action creates** ([D-342]), never one the screen
before already shows: a new screen by an element of its own (`appearsAfter()`
in `e2e/tests/helpers.ts` checks it was absent first), a server effect by its
response, a sync by `expectSynced()`, which waits for the outbox to drain:
the chip's "Alle Änderungen synchronisiert" alone is true before a write is
stored.

A failed or timed-out test in the functional, arch, OIDC or demo suite writes
`page-diagnosis.md` next to Playwright's `error-context.md` ([D-247]); CI
prints both. The functional, OIDC and demo
suites also keep the failed test's `trace.zip` (`npx playwright show-trace`).

**The integration project has two layers, and only one may know the
engine.** A spec in `frontend/src/integration/behaviour/` reaches the engine
through `world.ts` alone, and lint refuses one that reaches past it
([impl-notes](docs/internals/impl-notes.md#sync-behaviour-suite) says how).
Engine-internal assertions go in `integration/engine/` or `src/lib/sync/`.
`fuzz.test.ts` takes `STRESS_SEEDS`, `STRESS_STEPS` and `STRESS_TRACE`
(impl-notes).

**Worktrees are first-class ([D-177]).** Parallel agents each work in a git
worktree under `.claude/worktrees/<name>`, inside the bind mount; the gate
and `shots.sh` run in the checkout they were started from and build into its
own `backend/pb_public`, `frontend/build` and binary. A fresh worktree's
`node_modules` come from the gate's `deps` task. A worktree outside the main
checkout is not in the container at all.

## Things that will bite you

**One container per checkout** (worktrees inside it share it). A second
container on the same tree shares `backend/pb_data`, `backend/pb_public`,
`frontend/build` and `.svelte-kit`, and every full build deletes and rebuilds
`backend/pb_public` under whatever the other one serves.

**CI runs in the devcontainer's `toolchain` stage** ([D-203]), tagged by its
content in every workflow: after a change to that stage of
`.devcontainer/Dockerfile`, run `scripts/ci-image-tag.sh --write`, or CI's
`ci-image` workflow fails the push. A CI change is tried on the HOST (the
devcontainer has no Docker): `docker build --target toolchain -t
$(scripts/ci-image-tag.sh --image) .devcontainer`, then
`woodpeckerci/woodpecker-cli` with the socket mounted, `exec --local
--repo-path "$PWD" .woodpecker/<workflow>.yaml`, on a scratch clone (its steps
write as root).

**Woodpecker fills in every `${…}` in a workflow before the shell runs**,
comments included, and a name it does not know becomes `""`: a shell variable
in `commands` goes without braces. A `"${BASE%%:*}"` once became `""` in
`ci-image.yaml`, and its cleanup removed every image on the agent.

**Prefer a standard tool to a new script.** Every custom script has a row in
[D-252]'s table saying which standard tool it stands in for, or why there is
none; a new one adds its row, and a deleted one takes its row with it.

**The library's own tool, never a hand-built one.** Before writing a helper,
an event listener, an observer, a retry or wait loop, a fetch wrapper or an
effect that keeps state in sync, look for the feature in the installed
library's source and types (`node_modules`, the Go module cache), not in
memory of an older version: PocketBase and its SDK, Svelte and SvelteKit,
bits-ui, Dexie, SimpleWebAuthn, Playwright and testing-library cover most of
them. A hand-built copy is one more mechanism to get subtly wrong, and in
review it is a finding, not a style note. Keep one only where the library is
not equivalent, with that reason in one line beside it.

**Tool versions live in `tools/`, one Go module per tool** ([D-75],
`tools/README.md`): `go -C tools/<name> install tool` with no `@version`, the
module is the pin (Dex runs as `go -C tools/dex tool dex`). diff-cover, the one
Python tool, is pinned by hashes in `tools/diff-cover/requirements.txt`. A
version anywhere else (a Dockerfile ARG, a CI `environment:` block, an `npx`
argument) is one a Renovate manager in `renovate.json5` updates; one that no
manager reads is not added.

**`-tags no_ui` for any Go command on a tree without a built frontend:**
`backend/pb_public` is embedded at compile time ([D-64]), and a bare `go
vet/test/build` fails with `pattern all:pb_public: no matching files found`.
The e2e build deliberately omits it, because that binary carries the real UI.

**Test-only code never ships.** `backend/deps_arch_test.go` fails if a
package in the binary outside the standard library imports `testing`, or the
binary links `internal/testutil`/`dextest`/`sectest` or a tool pinned under
`tools/`; a test helper imported by production code is how it
happens.

**The gate does not check the licence list:** after a dependency change, take
[CONTRIBUTING's step](CONTRIBUTING.md#before-you-send-a-change), or CI fails
on a stale file or a licence off the allowlist.

**Ports.** Each harness has its own (above); the shots harness takes 8091
(`app`), 8092 (`gallery`) and 8087, 8086 and Dex on 5558 (`docs`); 8099 is the
integration server. `scripts/dev.sh` holds 8090 (origin `:5173`, Dex on 5556
with `--oidc`). No harness reuses a running server, so Playwright refuses a
port that answers: adopting the dev server, every passkey ceremony would fail
on an origin mismatch.

**The gate runs beside `scripts/dev.sh`** ([D-157]) because the dev server
generates into `frontend/.svelte-kit-dev` and the Paraglide CLI and plugin
write only the files that changed, with one layout
(`frontend/project.inlang/paraglide.config.js`). A new generator writing into a tree the dev server
imports from reloads the open page on every layer. Memory is the limit: 8 GB,
no swap; an exit 137 in a log is the box, not the tool.

**Kill PIDs, never patterns.** `pgrep -af`, then `kill` the PIDs whose argv is
under this repo's path: a pattern also matches your own shell, any
shell that mentions the word, and the user's VS Code server in the same
container. The dev backend runs under `air` ([D-71]), so stop `air` before the
server or it restarts it.

**`normalizeName` is not the place to make matching smarter.**
`frontend/src/lib/normalize.ts` is a matched pair with
`backend/internal/normalize/normalize.go`, pinned by
`backend/seed/normalization-vectors.json`, and its output decides the
server's destructive duplicate-create merge ([§8.3] [D-29]); its exclusions are
decisions ([D-44]). Build looser matching beside it, as
`frontend/src/lib/classify.ts` does, and off every path to the outbox; lint
refuses it in the engine, the actions, `dedup`, `item-name` and `normalize`
([D-221]).

## Checking UI work with screenshots

The component suite runs on happy-dom and cannot see what something looks
like, and many bugs here were visual. Take screenshots and read them.
`scripts/shots.sh` (`e2e/shots`; it takes the machine lock):

- **`gallery [--label L] [--clip] [STATE…]`**: every item case and density from
  the design gallery, no backend (~15s). A STATE is the gallery's query string
  (axes in `frontend/src/routes/dev/gallery/axes.ts`). For a change to
  `ShopTile`, the rows or `app.css`, shoot `--label before` and `--label
  after` and compare. `--clip` keeps each frame's height, so cut-off content
  shows.
- **`app [--locales "en de"] [--themes "light dark"]`**: the real app as one
  household's story on a fresh server, plus `clip.webp` of two phones ticking
  off one list (~1½ min with the build). The barcode scan is real past the
  camera ([D-21]), so it needs the container's internet.
- **`readme`** and **`docs`** regenerate `docs/screenshots/` and `docs/images/`;
  run them when a change alters one of those screens. **`readme IMAGE…`**
  (`readme import`) shoots only the images named, without the clip or
  the barcode scan unless one of them shows it: under half a minute of
  shooting where the whole set takes four. A screen a change touches is
  usually on more than one image (an aisle colour is on most), so name them
  all, or run the whole set.

Images land in `logs/shots/<stamp>[-label]/` (`logs/shots/latest`). The
harness photographs and asserts nothing, so neither the gate nor CI runs it.
For markup the app never renders, screenshot a throwaway page with the real
CSS in the container's Chromium.

**Buttons:** `/dev/gallery?page=buttons` is the family's reference, read from
`buttonVariants` and the source ([D-312]). A new variant or size needs its
rule there (`ROLES`/`SIZES` in `ButtonGallery.svelte`), and one it lists as
unused is removed.

**Design tokens:** `/dev/gallery?page=design` is the reference for type
roles, the ramp, weights, radii, elevations, surfaces, layers, colours, icon
sizes and fields, read from `app.css` ([D-314], [D-316], [D-317]). Lint refuses Tailwind's stock answer where
`app.css` has one (`eslint.shared.config.js`, `tokenClasses`), and outside
`ui/` any arbitrary value or inline style but a custom property ([D-333]); a
new look goes into a `ui/` part or an `app.css` token, not into a caller's
classes. A look a second screen needs becomes a part, and lint refuses the
hand-drawn copy where it can be named.

<!-- citation links (generated by scripts/decisions-index.mjs) -->

[§8.3]: docs/internals/design.md#8-3-push-endpoint-server-side-merge
[D-21]: docs/internals/decisions.md#D-21
[D-29]: docs/internals/decisions.md#D-29
[D-44]: docs/internals/decisions.md#D-44
[D-64]: docs/internals/decisions.md#D-64
[D-71]: docs/internals/decisions.md#D-71
[D-75]: docs/internals/decisions.md#D-75
[D-76]: docs/internals/decisions.md#D-76
[D-124]: docs/internals/decisions.md#D-124
[D-154]: docs/internals/decisions.md#D-154
[D-157]: docs/internals/decisions.md#D-157
[D-166]: docs/internals/decisions.md#D-166
[D-177]: docs/internals/decisions.md#D-177
[D-203]: docs/internals/decisions.md#D-203
[D-221]: docs/internals/decisions.md#D-221
[D-228]: docs/internals/decisions.md#D-228
[D-234]: docs/internals/decisions.md#D-234
[D-241]: docs/internals/decisions.md#D-241
[D-243]: docs/internals/decisions.md#D-243
[D-247]: docs/internals/decisions.md#D-247
[D-252]: docs/internals/decisions.md#D-252
[D-301]: docs/internals/decisions.md#D-301
[D-312]: docs/internals/decisions.md#D-312
[D-314]: docs/internals/decisions.md#D-314
[D-316]: docs/internals/decisions.md#D-316
[D-317]: docs/internals/decisions.md#D-317
[D-333]: docs/internals/decisions.md#D-333
[D-336]: docs/internals/decisions.md#D-336
[D-337]: docs/internals/decisions.md#D-337
[D-342]: docs/internals/decisions.md#D-342
[D-343]: docs/internals/decisions.md#D-343
