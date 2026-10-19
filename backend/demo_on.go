//go:build demo

package main

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"shoppinglist/internal/demo"
)

// The demo build ([D-234]): `go build -tags demo`. The normal build gets
// demo_off.go, and deps_arch_test.go checks that it links none of this.

// demoBuild says the demo's start route is a login method of its own.
const demoBuild = true

type demoConfig = demo.Config

func demoFromEnv(passkeys, oidc bool) (demoConfig, error) { return demo.FromEnv(passkeys, oidc) }

func demoLogLine(cfg demoConfig) string { return demo.Describe(cfg) }

func registerDemoRoutes(r *router.RouterGroup[*core.RequestEvent], cfg demoConfig) {
	demo.RegisterRoutes(r, cfg)
}

func registerDemoJobs(app core.App) error { return demo.Register(app) }
