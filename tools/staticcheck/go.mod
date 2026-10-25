// staticcheck — see ../README.md. Its module semver is not the release number --version prints.
// One module per tool, deliberately: a shared module makes MVS pick one
// dependency set for all of them, which broke osv-scanner ([D-75]).
// golang.org/x/tools is held at v0.51.0, ahead of staticcheck 0.8.1's own
// requirement: older versions cannot read Go 1.27.2's export data (version 5)
// and fail on every standard-library import.

module shoppinglist/tools/staticcheck

go 1.26.0

tool honnef.co/go/tools/cmd/staticcheck

require (
	github.com/BurntSushi/toml v1.4.1-0.20240526193622-a339e1f7089c // indirect
	golang.org/x/exp/typeparams v0.0.0-20231108232855-2478ac86f678 // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/tools v0.51.0 // indirect
	honnef.co/go/tools v0.8.2 // indirect
)
