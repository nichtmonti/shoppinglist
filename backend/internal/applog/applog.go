// Package applog writes a server event to both logs: PocketBase's, read only
// through the dashboard that SHOPPINGLIST_ADMIN_UI=off takes away, and the
// container's, which every operator can read.
//
// Which log a line goes to: a boot line, which says how this process is
// configured (the serve environment, the setup link), and anything logged
// before PocketBase's own log exists (the pre-upgrade backup), is printed with
// log.Printf to the container log alone; the setup link must not reach the
// database. Everything else, a failure, a WARNING to act on or a thing the
// server did on its own, goes through this package, so the dashboard shows it
// too.
package applog

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"strconv"
	"strings"
	"unicode"

	"github.com/pocketbase/pocketbase/core"
)

// Info logs msg and the key-value attrs; the container line reads
// "shoppinglist: msg key=value …".
func Info(app core.App, msg string, attrs ...any) {
	write(app, slog.LevelInfo, "", msg, nil, attrs)
}

// Warn logs msg, err (if any) and the key-value attrs as a warning; the
// container line reads "shoppinglist: WARNING msg: err key=value …".
func Warn(app core.App, msg string, err error, attrs ...any) {
	write(app, slog.LevelWarn, "WARNING ", msg, err, attrs)
}

// Error logs msg, err (if any) and the key-value attrs as an error; the
// container line reads "shoppinglist: msg: err key=value …".
func Error(app core.App, msg string, err error, attrs ...any) {
	write(app, slog.LevelError, "", msg, err, attrs)
}

func write(app core.App, level slog.Level, prefix, msg string, err error, attrs []any) {
	var line strings.Builder
	line.WriteString("shoppinglist: " + prefix + msg)
	// PocketBase stores a line's attributes as JSON, which refuses some
	// values (a time.Duration); the dashboard gets each as the text the
	// container line shows, so no attribute can cost the line.
	var stored []any
	if err != nil {
		line.WriteString(": " + text(err))
		stored = append(stored, "error", err.Error())
	}
	for i := 0; i+1 < len(attrs); i += 2 {
		fmt.Fprintf(&line, " %v=%s", attrs[i], text(attrs[i+1]))
		stored = append(stored, fmt.Sprint(attrs[i]), fmt.Sprint(attrs[i+1]))
	}
	log.Print(line.String())
	app.Logger().Log(context.Background(), level, "shoppinglist: "+msg, stored...)
}

// text is v as the container line shows it: %q-quoted when it is empty or
// holds a space, a quote, an '=' or anything unprintable, so no value can
// split the line or pass for another key=value.
func text(v any) string {
	s := fmt.Sprint(v)
	if s == "" || strings.ContainsFunc(s, func(r rune) bool {
		return r == ' ' || r == '"' || r == '=' || !unicode.IsPrint(r)
	}) {
		return strconv.Quote(s)
	}
	return s
}
