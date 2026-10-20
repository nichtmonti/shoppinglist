// Package applog writes a server event to both logs: PocketBase's, read only
// through the dashboard that SHOPPINGLIST_ADMIN_UI=off takes away, and the
// container's, which every operator can read.
//
// Which log a line goes to: a boot line, which says how this process is
// configured (the serve environment, the setup link), and anything logged
// before PocketBase's own log exists (the pre-upgrade backup), is printed with
// log.Printf to the container log alone; the setup link must not reach the
// database. Everything else, a failure, a warning to act on or a thing the
// server did on its own, goes through this package, so the dashboard shows it
// too.
package applog

import (
	"context"
	"fmt"
	"log"
	"log/slog"

	"github.com/pocketbase/pocketbase/core"
)

// Info logs msg and the key-value attrs; the container line reads
// `level=INFO msg="shoppinglist: msg" key=value …`.
func Info(app core.App, msg string, attrs ...any) {
	write(app, slog.LevelInfo, msg, nil, attrs)
}

// Warn logs msg, err (if any) and the key-value attrs as a warning: level=WARN.
func Warn(app core.App, msg string, err error, attrs ...any) {
	write(app, slog.LevelWarn, msg, err, attrs)
}

// Error logs msg, err (if any) and the key-value attrs as an error: level=ERROR.
func Error(app core.App, msg string, err error, attrs ...any) {
	write(app, slog.LevelError, msg, err, attrs)
}

// write sends one record to PocketBase's log and, as slog's text format, to
// the container's: the standard library quotes a value that would split the
// line or pass for another key=value.
func write(app core.App, level slog.Level, msg string, err error, attrs []any) {
	// PocketBase stores a line's attributes as JSON, which refuses some
	// values (a time.Duration); each goes as text, so no attribute can cost
	// the line.
	var text []any
	if err != nil {
		text = append(text, "error", err.Error())
	}
	for i := 0; i+1 < len(attrs); i += 2 {
		text = append(text, fmt.Sprint(attrs[i]), fmt.Sprint(attrs[i+1]))
	}
	// log's output, taken at the call, is the container log (a test captures it).
	container := slog.NewTextHandler(log.Writer(), nil)
	slog.New(slog.NewMultiHandler(app.Logger().Handler(), container)).
		Log(context.Background(), level, "shoppinglist: "+msg, text...)
}
