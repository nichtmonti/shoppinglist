# Application image (docs/internals/design.md §14, [D-36], [D-62]).
#
# GoReleaser (dockers_v2, buildx) builds the binaries for every target
# platform BEFORE this Dockerfile ever runs, so this file only packages —
# it must never `go build`/`pnpm build` here (that would duplicate work and
# defeat the whole point of GoReleaser's build/package split). The build
# context GoReleaser hands this Dockerfile is a temp dir shaped like:
#
#   linux/amd64/shoppinglist
#   linux/arm64/shoppinglist
#   linux/arm/v7/shoppinglist
#
# Just the binaries: the SvelteKit SPA is compiled into each one ([D-64]), so
# nothing has to be copied alongside them.
#
# Base: distroless static, not scratch ([D-62]). The binary is pure-Go
# (modernc.org/sqlite, CGO_ENABLED=0) so scratch would *run* — but scratch has
# no CA bundle, and Go on Linux has no compiled-in root store, so every
# outbound HTTPS call from internal/barcode (world.openfoodfacts.org and its
# three sister sites, [D-21]) would fail with "x509: certificate signed by
# unknown authority". distroless static ships /etc/ssl/certs/ca-certificates.crt,
# /etc/passwd and tzdata and nothing else — no shell, no package manager,
# nothing to pivot to.
#
# Pinned by index digest so a rebuild of an old tag produces the same image;
# the digest covers linux/amd64, linux/arm64 and linux/arm/v7 (Raspberry Pi, §14).
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
ARG TARGETPLATFORM

# Deliberately NOT --chown'd: the app runs as 65532 and has no business
# writing the binary it executes. It stays root-owned and world-readable,
# which is also what lets the container run under an arbitrary uid
# (docs/deploy-reference.md#bind-mounting-a-host-directory-instead-of-a-named-volume).
COPY $TARGETPLATFORM/shoppinglist /shoppinglist

# The base image already sets USER 65532; repeated here because everything
# below depends on it and an inherited default is too easy to lose in a
# future base bump.
USER 65532:65532

# Creates /pb_data owned by the *current* USER, which is the point: Docker
# seeds a fresh named volume from the image directory at the mount path,
# ownership included, so `docker compose up` on a new host gets a data dir the
# app can actually write to. A bind mount keeps the host's ownership instead —
# docs/deploy-reference.md#bind-mounting-a-host-directory-instead-of-a-named-volume.
WORKDIR /pb_data

EXPOSE 8090

# The image has no shell and no curl, so the usual `CMD curl -fs .../api/health`
# is not available — the binary probes itself instead (internal/health).
# start-period covers first boot, where migrations run before the server binds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/shoppinglist", "healthcheck"]

ENTRYPOINT ["/shoppinglist", "serve", "--http=0.0.0.0:8090", "--dir=/pb_data"]
