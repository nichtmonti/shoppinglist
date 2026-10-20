# Deploying shoppinglist

The short path from nothing to a running, locked-down instance. Each step links
to the [deployment reference](deploy-reference.md), which has every setting and
the reasoning behind it. Once the instance is running,
[`operating.md`](operating.md) takes over.

## Before you start

- **HTTPS, with a certificate your devices trust.** Browsers give a page
  served over plain `http://` (other than `localhost`) none of what the app
  needs: adding an item, offline use, installing to the home screen and the
  camera all fail there.
- **A domain, for passkeys.** A passkey belongs to the domain it was made on,
  so **pick it before you invite anyone**: changing it later strands every
  passkey ([details](deploy-reference.md#getting-rp-id-and-rp-origin-right)).
  It does not have to be public; see [no public domain](#no-public-domain).
- **Docker** with Compose, or the plain binary from the
  [releases page](https://codeberg.org/sclermont/shoppinglist/releases)
  ([without Docker](deploy-reference.md#without-docker)).

### No public domain

For a household that never needs the app from outside, any of these works:

- **Tailscale.** `tailscale serve` gives the machine an HTTPS address such as
  `https://pi.example-tailnet.ts.net` with a real certificate. Use that host as
  `SHOPPINGLIST_RP_ID` and point `tailscale serve` at `127.0.0.1:8090`. Every
  phone then needs the Tailscale app, and the list syncs whenever it is
  connected.
- **A domain of yours, pointing at a home address.** A subdomain whose DNS
  record names the server's LAN address, with a certificate from a DNS
  challenge (Caddy and others do this), gives passkeys a real domain without
  opening anything to the internet.
- **No passkeys at all.** With your own OpenID Connect provider
  ([OIDC-only](deploy-reference.md#choosing-the-login-methods)), the app needs
  no domain: an IP address works, as long as it is served over HTTPS with a
  certificate your devices trust.

## 1. Configure

Take both files from the release you will run (the newest is on the
[releases page](https://codeberg.org/sclermont/shoppinglist/releases)).

```sh
V=X.Y.Z   # the release version, without the v
curl -LO https://codeberg.org/sclermont/shoppinglist/raw/tag/v$V/docker-compose.yml
curl -L -o .env https://codeberg.org/sclermont/shoppinglist/raw/tag/v$V/.env.example
```

In `.env`, change the two values marked `CHANGE`:

| Variable | Set it to |
|---|---|
| `SHOPPINGLIST_VERSION` | that version without the `v` (the `X.Y.Z` above), so a restart never upgrades you by surprise |
| `SHOPPINGLIST_RP_ID` | your bare domain, e.g. `list.example.com` |

Keep the other two it sets: `SHOPPINGLIST_SIGNUP=invite` lets in only people
you invite, and `SHOPPINGLIST_TRUSTED_PROXY_HEADER=X-Forwarded-For` gives every
user their own rate limit behind the proxy. Everything else is optional and
explained in `.env` itself. `SHOPPINGLIST_RP_ORIGIN` is needed only when the
address bar will not show exactly `https://` + your domain. Every setting is
in the [environment variable table](deploy-reference.md#environment-variables);
you should not need to edit `docker-compose.yml`.

## 2. Put a reverse proxy in front

The compose file publishes the app on `127.0.0.1:8090` only; keep it that way
and let the proxy terminate TLS. With Caddy, this is the whole config:

```caddyfile
list.example.com {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:8090
}
```

Do not add a Content-Security-Policy at the proxy: the app sends its own, and a
second one breaks it. nginx, Traefik and proxy chains:
[the reverse proxy is part of the security model](deploy-reference.md#the-reverse-proxy-is-part-of-the-security-model).

## 3. First boot

```sh
docker compose up -d
docker compose logs shoppinglist   # a container that exits names the reason here
```

The log has a line `no accounts yet and SHOPPINGLIST_SIGNUP=invite — create
the first account at https://…/#setup=…`. Open that link on your phone, create
your account with a passkey, then **reload and sign in again with the
passkey**. If registering works but signing in fails,
`SHOPPINGLIST_RP_ORIGIN` does not match the address bar
([first boot in full](deploy-reference.md#first-boot)). The link works once
and only until the first account exists; a restart before then prints a new
one.

To bring your household in, make a list, open its ⋮ menu, choose "Share &
members" and send them the link or QR code. Whoever opens it creates an
account right there and is on that list.

Create the admin (superuser) account. It can read and change everything on the
instance, so give it a long random password:

```sh
docker compose run --rm --entrypoint /shoppinglist shoppinglist \
  superuser upsert you@example.com 'a-long-random-password' --dir=/pb_data
```

You need it for the dashboard at `https://<your domain>/_/`, where backups and
settings are changed. Instead of the command, the log's one-time
`/_/#/pbinstall/…` link does the same within 30 minutes of the first start,
while the dashboard is on.

## 4. Lock it down

- Get the backups off the machine: the server zips the data volume every
  night into the volume itself ([`operating.md`](operating.md#backups)).
- Sign-up is already invite-only. `SHOPPINGLIST_SIGNUP=closed` stops new
  passkey accounts altogether; existing accounts keep working
  ([details](deploy-reference.md#restricting-who-can-sign-up)).
- `SHOPPINGLIST_ADMIN_UI=off` removes the admin dashboard at `/_/` entirely
  ([details](deploy-reference.md#turning-off-remote-administration)).

Restart with `docker compose up -d` after changing `.env`. The rest (sessions,
invite links, an optional egress allowlist) is in the
[hardening notes](deploy-reference.md#hardening-notes).

## Upgrades

1. Read the release's [changelog](../CHANGELOG.md) entry: anything you must do
   before upgrading is at its top.
2. Download that release's `docker-compose.yml` again (step 1), compare `.env`
   with its `.env.example`, and set `SHOPPINGLIST_VERSION` to the new version.
3. `docker compose pull && docker compose up -d`

Database changes apply at start, after the server has zipped the data
directory into `pb_data/backups/`; restoring that zip with the previous image
undoes the upgrade. An old `EINKAUFSLISTE_*` setting stops it with the name
to rename ([details](deploy-reference.md#upgrades)).

## Everything else

The [deployment reference](deploy-reference.md) also covers
[OIDC login](deploy-reference.md#oidc-login) and
[OIDC-only instances](deploy-reference.md#choosing-the-login-methods),
[running without Docker](deploy-reference.md#without-docker),
[bind mounts](deploy-reference.md#bind-mounting-a-host-directory-instead-of-a-named-volume),
[SQLite on NFS or virtiofs](deploy-reference.md#sqlite-on-network-storage) and
[health checks](deploy-reference.md#health-checks).
