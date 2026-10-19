package oidc

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

// The log keeps the token endpoint's status and error code, and the first line
// of any other failure, never what a provider wrote in its body or
// error_description, which can echo the request's parameters.
func TestFailureCauseLeavesOutTheProvidersText(t *testing.T) {
	const secret = "client_secret=s3cr3t"
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{
			"token error with a code",
			&oauth2.RetrieveError{
				Response:         &http.Response{Status: "401 Unauthorized"},
				Body:             []byte(`{"error":"invalid_client","error_description":"bad ` + secret + `"}`),
				ErrorCode:        "invalid_client",
				ErrorDescription: "bad " + secret,
			},
			"token endpoint answered 401 Unauthorized, invalid_client",
		},
		{
			"token error without a code",
			fmt.Errorf("exchange: %w", &oauth2.RetrieveError{
				Response: &http.Response{Status: "500 Internal Server Error"},
				Body:     []byte("stack trace with " + secret),
			}),
			"token endpoint answered 500 Internal Server Error, no error code",
		},
		{
			"userinfo error",
			errors.New("failed to fetch OAuth2 user profile via https://idp.example/userinfo (401):\n" + secret),
			"failed to fetch OAuth2 user profile via https://idp.example/userinfo (401):",
		},
	} {
		got := failureCause(tc.err)
		if got != tc.want {
			t.Errorf("%s: cause = %q, want %q", tc.name, got, tc.want)
		}
		if strings.Contains(got, secret) {
			t.Errorf("%s: the provider's text reached the log: %q", tc.name, got)
		}
	}
}
