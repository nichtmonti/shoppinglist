//go:build !demo

package main

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// The normal build's side of demo_on.go ([D-234]): no demo route, no sweep,
// and no import of internal/demo, so none of it is linked.

const demoBuild = false

type demoConfig struct{}

func demoFromEnv(bool, bool) (demoConfig, error) { return demoConfig{}, nil }

func demoLogLine(demoConfig) string { return "" }

func registerDemoRoutes(*router.RouterGroup[*core.RequestEvent], demoConfig) {}

func registerDemoJobs(core.App) error { return nil }
