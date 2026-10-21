# Running the public demo

The demo is a separate build of the app ([D-234]): visitors press one button,
get a throwaway account with three example lists, and everything is deleted 24
hours later. Nothing that identifies a visitor is written to disk. This page
is for whoever runs it; the design is in `design.md` §14 and the reasoning in
`decisions.md` [D-234].

## The image

Every release publishes the demo as an image beside the real one ([D-235]):
`codeberg.org/<owner>/shoppinglist:demo`, and `:X.Y.Z-demo` for a fixed
release, amd64 and arm64. On your own machine it needs nothing else:

```sh
docker run --rm -p 127.0.0.1:8090:8090 codeberg.org/<owner>/shoppinglist:demo
```

then http://localhost:8090. `Dockerfile.demo` sets what a local run needs
(passkeys off, `SHOPPINGLIST_APP_URL=http://localhost:8090`, the dashboard off,
no per-address start limit to speak of)
and has no volume, so everything goes when the container stops. The `-p` binds
the host's port to loopback: the tryout is reachable only on the machine that
runs it, not on the LAN or whatever else the host answers to. (Inside the
container the server binds 0.0.0.0, which Docker publishing requires; a public
demo puts a reverse proxy in front and changes the publish, not the bind.)
Two things in its log are PocketBase's own and do not apply: the link to create a superuser
and the "Dashboard" line (the dashboard is off and answers 404).

## Build it yourself

In the devcontainer (it has Go and node):

```sh
task build-demo                 # backend/shoppinglist-demo, linux/amd64
GOARCH=arm64 task build-demo    # for an arm64 server
```

One static file with the demo's SPA inside. The release's normal image and
binaries contain none of it (`backend/deps_arch_test.go` and
`task build-spa` check that).

## Configure

A public demo runs the same image (or binary) with the values below; the
image's defaults are a local run's. The demo binary refuses to start unless it
is set up as a demo:

| Variable | Value |
|---|---|
| `SHOPPINGLIST_PASSKEYS` | `off` (required) |
| `SHOPPINGLIST_OIDC` | unset or `off` (required) |
| `SHOPPINGLIST_APP_URL` | the demo's address, e.g. `https://demo.example.com` (required with passkeys off, unless `SHOPPINGLIST_RP_ORIGIN` is set) |
| `SHOPPINGLIST_TRUSTED_PROXY_HEADER` | `X-Forwarded-For`; otherwise every visitor shares one rate-limit bucket, and three starts lock everyone out for ten minutes |
| `SHOPPINGLIST_DEMO_MAX_ACCOUNTS` | how many demo accounts may exist at once (default 200) |
| `SHOPPINGLIST_DEMO_STARTS_PER_IP` | how many demos one address may start per 10 minutes (default 3; the image sets 1000, since locally every start comes from one address) |
| `SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT` | low, e.g. `5` |
| `SHOPPINGLIST_MAX_ITEMS_PER_LIST` | low, e.g. `200` |
| `SHOPPINGLIST_ADMIN_UI` | `off`, since the dashboard is not needed |

No `SHOPPINGLIST_RP_ID`: there are no passkeys. The scanner can stay on; it
sends only barcodes to Open Food Facts. The other variables are in
[`../deploy-reference.md`](../deploy-reference.md#environment-variables).

Run it like any binary (`shoppinglist-demo serve --http=127.0.0.1:8090
--dir=/var/lib/shoppinglist-demo`), behind a reverse proxy that terminates TLS,
as `../deploying.md` describes.

## Keep it free of personal data

What the binary does by itself:

- PocketBase's request log is off (retention 0 days, set at every boot), so no
  IP address or user agent is stored.
- The rate limits key on the IP address in memory only.
- Accounts have no email and a generated nickname, and are deleted with their
  lists 24 hours after creation, checked every 10 minutes.

What is up to you:

- **The reverse proxy's access log.** Caddy writes none unless configured to.
  nginx logs every request by default: `access_log off;` in the demo's server
  block.
- **No backups.** A backup would keep what the sweep deletes. Also leave the
  data directory out of any server-wide backup.
- **Error output.** The demo prints its errors to stderr; whatever collects that
  (journald, `docker logs`) keeps it on its own schedule. It contains no
  visitor data, only account ids.
- **Imprint and privacy notice.** A public site run from Germany may need both,
  even one that stores nothing. The notice can say: IP addresses are processed
  to deliver the page and limit requests and are not stored; what visitors
  type is deleted after 24 hours.

## Check it

```sh
curl -s -X POST -H 'Content-Type: application/json' -d '{}' https://demo.example.com/api/demo/start | head -c 120
```

answers with a token and a "Gast …" account, and the boot log has the line
`shoppinglist: DEMO build — …`.
