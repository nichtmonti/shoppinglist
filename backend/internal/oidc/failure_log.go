package oidc

import (
	"errors"
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"golang.org/x/oauth2"

	"shoppinglist/internal/applog"
)

// oauth2Path is PocketBase's own sign-in exchange, which the app's popup flow
// ends in once the provider has accepted the user ([D-76]).
const oauth2Path = "/api/collections/accounts/auth-with-oauth2"

// LogOAuth2Failure writes a failed sign-in exchange to both server logs, with
// PocketBase's underlying cause and what to check. PocketBase keeps the cause
// only in its request log, which a hardened instance cannot read ([D-209]),
// and these failures are almost always configuration only the operator can
// fix.
func LogOAuth2Failure(e *core.RequestEvent) error {
	err := e.Next()
	if err == nil || e.Request.URL.Path != oauth2Path {
		return err
	}
	// A server error is applog.ServerErrors' to log.
	if apiErr, ok := errors.AsType[*router.ApiError](err); ok && apiErr.Status >= 500 {
		return err
	}
	message, attrs := err.Error(), []any{}
	if apiErr, ok := errors.AsType[*router.ApiError](err); ok {
		message = apiErr.Message
		if raw, ok := apiErr.RawData().(error); ok {
			attrs = append(attrs, "cause", failureCause(raw))
		}
	}
	if hint := oauth2Hint(message); hint != "" {
		attrs = append(attrs, "check", hint)
	}
	applog.Warn(e.App, "OIDC sign-in failed after the provider accepted it", nil, append([]any{"error", message}, attrs...)...)
	return err
}

// failureCause is what of the exchange's error the log keeps: the token
// endpoint's status and RFC 6749 error code, or the first line of any other
// error (the userinfo failure puts the provider's body on the lines after).
// Never a provider's body or error_description, which can echo the request's
// parameters.
func failureCause(err error) string {
	if re, ok := errors.AsType[*oauth2.RetrieveError](err); ok {
		status := "no response"
		if re.Response != nil {
			status = re.Response.Status
		}
		code := re.ErrorCode
		if code == "" {
			code = "no error code"
		}
		return fmt.Sprintf("token endpoint answered %s, %s", status, code)
	}
	first, _, _ := strings.Cut(err.Error(), "\n")
	return strings.TrimSpace(first)
}

// oauth2Hint names the settings behind PocketBase's two exchange failures.
func oauth2Hint(message string) string {
	switch {
	case strings.Contains(message, "OAuth2 token"):
		return "the client secret, the token endpoint (SHOPPINGLIST_OIDC_ISSUER, or SHOPPINGLIST_OIDC_TOKEN_URL), and that the provider's callback URL is <app-origin>/api/oauth2-redirect"
	case strings.Contains(message, "OAuth2 user"):
		return "the userinfo endpoint (SHOPPINGLIST_OIDC_ISSUER, or SHOPPINGLIST_OIDC_USERINFO_URL)"
	}
	return ""
}
