# Contributing

Thanks for looking. This page gets you from a checkout to a running app and a
passing test run. [`AGENTS.md`](AGENTS.md) has the full rules and the traps the
project has fallen into; it is written for coding agents, but holds for people
too, so look things up there rather than reading it front to back.

## Issues and ideas

Bug reports are welcome as an
[issue](https://codeberg.org/sclermont/shoppinglist/issues): the version
(Settings shows it), what you did, and what happened. Ideas are welcome too,
but the scope is narrow on purpose (see the README's
[Is it for you?](README.md#is-it-for-you)), so for anything larger, open an
issue before writing code. Security problems go by email instead
([`SECURITY.md`](SECURITY.md)).

## Set up

The whole toolchain (Go, Node, pnpm, Playwright) lives in the devcontainer
([`.devcontainer/`](.devcontainer/)). The host needs Docker, plus VS Code with
the Dev Containers extension or the `devcontainer` CLI, and the first run
downloads the dependencies. Open the repo in VS Code and choose **Reopen in
Container**, or:

```sh
devcontainer up --workspace-folder .
```

Use **one container per checkout**: a second one on the same tree tears down
the build output the first is serving ([details](AGENTS.md#things-that-will-bite-you)).

A coding agent runs best inside it: `scripts/agent.sh` starts Claude Code
(`scripts/agent.sh opencode` or `omp` for those) in the container, with your
host login and sessions mounted, so its test runs are ordinary processes.

For that, the container mounts the agents' folders from your home directory
(`~/.claude`, `~/.omp`, `~/.opencode` and their config, cache and state) and
`~/.ssh` read-only, for `git push` from inside. Docker cannot mount a missing
folder, so `.devcontainer/initialize.sh` creates any that are missing, empty.
Delete the `mounts` list from your copy of `devcontainer.json` if you want
none of them.

## Run the app

Inside the container:

```sh
./scripts/dev.sh
```

Then open **http://localhost:5173**, exactly that origin, since passkeys are
bound to it. Frontend and backend both reload on save.

`./scripts/dev.sh --oidc` also starts a local OpenID Connect provider
([Dex](https://dexidp.io), pinned in `tools/dex`) and turns the OIDC login on
against it: sign in as `anna@example.com` or `bob@example.com`, password
`password`. Forward port 5556 as well as 5173 when the browser is on the host.
`--oidc-only` also turns passkeys off.

## Test

**A change of behaviour brings its test.** A new feature adds automated tests
for what it does, and a bug fix adds a test that fails without the fix. Put
it in the lowest layer that sees the behaviour: a Go test for the server, a
vitest test for a component or the sync engine, a Playwright spec for what
only a browser shows ([the layers](docs/internals/impl-notes.md#test-layers)).
A refactor keeps the existing tests passing; a change to docs, CI or tooling
needs none. A pull request that adds no test says why.

In the devcontainer:

```sh
scripts/gate.sh                 # the fast layers your change can reach, no browser
scripts/gate.sh e2e:functional -- tests/<spec>.spec.ts   # a browser spec
cd frontend && pnpm test:client # vitest watch for component tests
```

The gate is [go-task](https://taskfile.dev) (`Taskfile.yml`; `task --list`
shows the tasks to run) and skips what passed and has not changed since, so a
rerun repeats only what failed. Its log is `logs/latest.log`. The layers and
their ports are in
[`docs/internals/impl-notes.md`](docs/internals/impl-notes.md#test-layers),
and how to run them in
[`AGENTS.md`](AGENTS.md#run-the-tests-inside-the-devcontainer).

Every `git push` first scans the history for secrets with gitleaks (a hook in
`.githooks/`, which the devcontainer enables). From the host it runs in the
devcontainer, so keep one running; `git push --no-verify` skips the scan.

To see a UI change rather than test it, `scripts/shots.sh app` photographs the
app's main screens and `scripts/shots.sh gallery` the item components in every
state ([details](AGENTS.md#checking-ui-work-with-screenshots)).
`scripts/shots.sh readme` and `docs` regenerate the screenshots in
`docs/screenshots/` and `docs/images/`.

## Before you send a change

Send a change as a pull request against `main` on
[Codeberg](https://codeberg.org/sclermont/shoppinglist/pulls); CI runs on it,
and the maintainer reviews it. Before you open one:

- Read the relevant part of the spec, [`docs/internals/design.md`](docs/internals/design.md).
  Code cites it as `§n` and `[D-nn]`; the decisions behind it, with the
  alternatives that were rejected, are in
  [`docs/internals/decisions.md`](docs/internals/decisions.md). A change of
  behaviour updates the spec too.
- Add the tests the change needs ([the policy](#test)) and run them.
- If users or operators will notice the change, add a line under
  `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md) in the same commit.
- Run `pnpm format` (repo root) to format.
- After adding, removing or updating a dependency, run
  `task licenses` in the container and commit
  `docs/THIRD_PARTY_LICENSES.md` and `docs/sbom.cdx.json`, or CI fails.

## CI

Woodpecker, in [`.woodpecker/`](.woodpecker/). Every workflow waits for
`ci-image.yaml`, which builds the CI image on the agent's own Docker daemon
through its socket, so the repository must be marked *trusted* on your agent
(the host cache `volumes:` elsewhere are optional). The release workflow also
needs a Docker backend that allows privileged containers (its `dind` service)
and the two token secrets listed in [`release.yaml`](.woodpecker/release.yaml).
