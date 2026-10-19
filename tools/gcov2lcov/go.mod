// gcov2lcov — see ../README.md.
// One module per tool, deliberately: a shared module makes MVS pick one
// dependency set for all of them, which broke osv-scanner ([D-75]).

module shoppinglist/tools/gcov2lcov

go 1.27.2

tool github.com/jandelgado/gcov2lcov

require github.com/jandelgado/gcov2lcov v1.1.1 // indirect
