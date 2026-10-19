//go:build demo

package main

import (
	"strings"
	"testing"
)

// The demo build's serve environment ([D-234]): it boots with no other login
// at all, which the normal build refuses, and refuses both of the others.
func TestBuildServeEnvDemo(t *testing.T) {
	t.Run("boots with passkeys off, no OIDC and no RP-ID", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_PASSKEYS", "off")
		t.Setenv("SHOPPINGLIST_RP_ID", "")
		t.Setenv("SHOPPINGLIST_APP_URL", "https://demo.example.com")
		t.Setenv("SHOPPINGLIST_OIDC", "")
		t.Setenv("SHOPPINGLIST_DEMO_MAX_ACCOUNTS", "50")
		env, err := parseServeEnv()
		if err != nil {
			t.Fatalf("parseServeEnv: %v", err)
		}
		if env.demo.MaxAccounts != 50 {
			t.Errorf("MaxAccounts = %d, want 50", env.demo.MaxAccounts)
		}
		if env.wacfg.RPOrigin != "https://demo.example.com" {
			t.Errorf("RPOrigin = %q, want the app URL", env.wacfg.RPOrigin)
		}
	})

	t.Run("passkeys on is refused", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_RP_ID", "demo.example.com")
		_, err := parseServeEnv()
		if err == nil || !strings.Contains(err.Error(), "SHOPPINGLIST_PASSKEYS=off") {
			t.Fatalf("err = %v, want a refusal naming SHOPPINGLIST_PASSKEYS=off", err)
		}
	})

	t.Run("OIDC on is refused", func(t *testing.T) {
		t.Setenv("SHOPPINGLIST_PASSKEYS", "off")
		t.Setenv("SHOPPINGLIST_APP_URL", "https://demo.example.com")
		t.Setenv("SHOPPINGLIST_OIDC", "on")
		t.Setenv("SHOPPINGLIST_OIDC_CLIENT_ID", "c")
		t.Setenv("SHOPPINGLIST_OIDC_CLIENT_SECRET", "s")
		t.Setenv("SHOPPINGLIST_OIDC_AUTH_URL", "https://idp.example.com/auth")
		t.Setenv("SHOPPINGLIST_OIDC_TOKEN_URL", "https://idp.example.com/token")
		t.Setenv("SHOPPINGLIST_OIDC_USERINFO_URL", "https://idp.example.com/userinfo")
		_, err := parseServeEnv()
		if err == nil || !strings.Contains(err.Error(), "SHOPPINGLIST_OIDC") {
			t.Fatalf("err = %v, want a refusal naming SHOPPINGLIST_OIDC", err)
		}
	})
}
