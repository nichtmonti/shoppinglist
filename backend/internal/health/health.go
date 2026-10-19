// Package health implements the `shoppinglist healthcheck` subcommand: a
// one-shot HTTP probe of this instance's own /api/health, used as the
// container image's HEALTHCHECK because the distroless release image has no
// curl ([D-62]). It never touches the database (see NewCommand).
package health

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/spf13/cobra"
)

// CommandName is the argv token main.go short-circuits on.
const CommandName = "healthcheck"

// DefaultAddr is where the server listens inside the release image
// (the Dockerfile's `serve --http=0.0.0.0:8090`, reached over loopback).
const DefaultAddr = "127.0.0.1:8090"

// defaultTimeout bounds the whole probe, so it exits on its own rather than
// being SIGKILLed by Docker's HEALTHCHECK --timeout.
const defaultTimeout = 3 * time.Second

// Probe performs one GET of http://<addr>/api/health and returns an error
// unless it answered 2xx. The error says what failed, since an operator reads
// it from `docker inspect`'s health log.
func Probe(addr string, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}

	url := fmt.Sprintf("http://%s/api/health", addr)
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	// Drain (bounded) so the connection closes cleanly.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("GET %s: unhealthy status %d", url, resp.StatusCode)
	}
	return nil
}

// NewCommand builds the cobra command.
//
// It must never run through PocketBase's RootCmd: Execute bootstraps the app,
// opening the live database, for every known subcommand except help/version,
// and a healthcheck runs every 30 seconds. main.go runs it standalone before
// pocketbase.New(); the copy on RootCmd exists only for `--help`.
func NewCommand() *cobra.Command {
	addr := DefaultAddr
	timeout := defaultTimeout

	cmd := &cobra.Command{
		Use:   CommandName,
		Args:  cobra.NoArgs,
		Short: "Probe this instance's /api/health and exit 0 if it is serving",
		Long: "One-shot HTTP probe of an already-running server, used as the " +
			"container image's HEALTHCHECK (the release image is distroless — " +
			"no shell, no curl). Exits 0 when /api/health answers 2xx and 1 " +
			"otherwise.\n\nDoes not open the database and does not start a " +
			"server: it only talks to one that is already listening.",
		// main.go logs the error and sets the exit code; cobra printing it
		// too would double the line in the health log.
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			return Probe(addr, timeout)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", DefaultAddr,
		"host:port of the running server to probe")
	cmd.Flags().DurationVar(&timeout, "timeout", defaultTimeout,
		"give up on the probe after this long")
	return cmd
}
