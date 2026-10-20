package main

// knownSettings is every SHOPPINGLIST_ name an operator may set ([D-336]):
// what the server reads, the demo build's included, and the two that
// docker-compose.yml fills in itself and hands over with the rest of .env.
// scripts/env-check.mjs fails CI when it and the names the code reads differ.
var knownSettings = []string{
	"SHOPPINGLIST_ADMIN_UI",
	"SHOPPINGLIST_APP_URL",
	"SHOPPINGLIST_DEMO_MAX_ACCOUNTS",
	"SHOPPINGLIST_DEMO_STARTS_PER_IP",
	"SHOPPINGLIST_MAX_ITEMS_PER_LIST",
	"SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT",
	"SHOPPINGLIST_OIDC",
	"SHOPPINGLIST_OIDC_AUTH_URL",
	"SHOPPINGLIST_OIDC_CLIENT_ID",
	"SHOPPINGLIST_OIDC_CLIENT_SECRET",
	"SHOPPINGLIST_OIDC_ISSUER",
	"SHOPPINGLIST_OIDC_NAME",
	"SHOPPINGLIST_OIDC_TOKEN_URL",
	"SHOPPINGLIST_OIDC_USERINFO_URL",
	"SHOPPINGLIST_PASSKEYS",
	"SHOPPINGLIST_RP_ID",
	"SHOPPINGLIST_RP_ORIGIN",
	"SHOPPINGLIST_SCANNER",
	"SHOPPINGLIST_SIGNUP",
	"SHOPPINGLIST_SOURCE_URL",
	"SHOPPINGLIST_TRUSTED_PROXY_HEADER",
	"SHOPPINGLIST_TRUSTED_PROXY_LEFTMOST",
	// docker-compose.yml's own.
	"SHOPPINGLIST_BIND",
	"SHOPPINGLIST_VERSION",
	// Not settings: the repo's tooling sets them around the servers it starts
	// (the devcontainer, the gate, the harnesses, the builds).
	"SHOPPINGLIST_BIN",
	"SHOPPINGLIST_DEMO_BIN",
	"SHOPPINGLIST_DEMO_BUILD",
	"SHOPPINGLIST_DEV_INSTANCE",
	"SHOPPINGLIST_DEVCONTAINER",
	"SHOPPINGLIST_TPL_OUT",
}
