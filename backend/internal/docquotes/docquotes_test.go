// Package docquotes holds the docs to what they quote: the app's own strings,
// the server's log lines and the messages' wording. It is a Go test because
// Go's test cache reruns a package when a file it read changes, so a docs-only
// edit reruns this one, where vitest --changed sees no change; the gate's
// go-test layer lists those files as its sources.
package docquotes

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The repository's root, from this package.
const repoRoot = "../../../"

// What the docs quote in "…" that no message says, each with why.
var notMessages = map[string]string{
	`CHANGELOG.md "Connecting failed. The window was closed or the provider refused."`: "the message this release removed",
}

// The docs quote the app's English in "…" and its German in „…“, ‹name› for a
// message's {name}. A quote is a message, or its start: up to the end of a
// sentence, or cut short with "…". Other quoted text takes “…”. CHANGELOG.md's
// released sections are history, quoting what the app said then.
func TestDocsQuoteTheApp(t *testing.T) {
	en, de := messages(t, "en"), messages(t, "de")
	var seed []struct {
		Name map[string]string `json:"name_i18n"`
	}
	readJSON(t, "backend/seed/categories.json", &seed)
	for _, c := range seed {
		en, de = append(en, c.Name["en"]), append(de, c.Name["de"])
	}

	placeholder := regexp.MustCompile(`‹(\w+)›`)
	used := map[string]bool{}
	for _, doc := range []string{"README.md", "docs/using.md", "docs/deploying.md", "docs/deploy-reference.md",
		"docs/operating.md", "docs/internals/design.md", "CHANGELOG.md"} {
		text := blank(prose(read(t, doc)), `<[^>]*>`)
		if doc == "CHANGELOG.md" {
			text = unreleased(text)
		}
		for _, lang := range []struct {
			quote    *regexp.Regexp
			messages []string
			file     string
		}{
			{regexp.MustCompile(`"([^"]*)"`), en, "en.json"},
			{regexp.MustCompile(`„([^“]*)“`), de, "de.json"},
		} {
			for _, m := range lang.quote.FindAllStringSubmatchIndex(text, -1) {
				quote := strings.Join(strings.Fields(text[m[2]:m[3]]), " ")
				if quotesAny(placeholder.ReplaceAllString(quote, "{$1}"), lang.messages) {
					continue
				}
				if key := doc + ` "` + quote + `"`; notMessages[key] != "" {
					used[key] = true
					continue
				}
				t.Errorf("%s:%d quotes %q, which is no message in %s or seed category; quote other text with “…”",
					doc, line(text, m[0]), quote, lang.file)
			}
		}
	}
	for key := range notMessages {
		if !used[key] {
			t.Errorf("notMessages lists %s, which the docs no longer quote", key)
		}
	}
}

// quotesAny reports whether quote is one of messages or the start of one.
func quotesAny(quote string, messages []string) bool {
	head, cut := strings.CutSuffix(quote, "…")
	for _, message := range messages {
		if rest, ok := strings.CutPrefix(message, head); ok && (rest == "" || rest[0] == '.' || cut && head != "") {
			return true
		}
	}
	return false
}

// The operator docs quote the server's log lines in backticks: a line with
// "shoppinglist: " in it, or what a `docker compose logs … | grep '…'`
// filters for. Its message ("…" for any text, a number for any number) must be
// in the server's code, and every key=value's key too.
func TestDocsQuoteTheServer(t *testing.T) {
	source := serverSource(t)
	// A line's message, and the key=value pairs after it.
	logLine := regexp.MustCompile(`(?:level=\w+ msg="shoppinglist: ([^"]*)"?|shoppinglist: (\S.*?))((?: \w+=.*)?)$`)
	grep := regexp.MustCompile(`logs [^|]*\| grep '([^']+)'`)
	key := regexp.MustCompile(`\b(\w+)=`)
	for _, doc := range []string{"docs/deploying.md", "docs/deploy-reference.md", "docs/operating.md", ".env.example"} {
		for _, code := range regexp.MustCompile("(?s)```[^\n]*\n(.*?)```|`([^`]+)`").FindAllStringSubmatch(read(t, doc), -1) {
			for quoted := range strings.SplitSeq(code[1]+code[2], "\n") {
				var message, pairs string
				if m := logLine.FindStringSubmatch(quoted); m != nil {
					message, pairs = m[1]+m[2], m[3]
				} else if m := grep.FindStringSubmatch(quoted); m != nil {
					message = m[1]
				} else {
					continue
				}
				pattern := strings.ReplaceAll(regexp.QuoteMeta(message), "…", ".*")
				pattern = regexp.MustCompile(`\d+`).ReplaceAllString(pattern, `(?:\d+|%d)`)
				if !regexp.MustCompile(pattern).MatchString(source) {
					t.Errorf("%s quotes the log line %q, whose message %q the server does not write", doc, quoted, message)
				}
				for _, k := range key.FindAllStringSubmatch(pairs, -1) {
					if !strings.Contains(source, `"`+k[1]+`"`) && !strings.Contains(source, k[1]+"=") {
						t.Errorf("%s quotes the log line %q, whose key %s the server does not write", doc, quoted, k[1])
					}
				}
			}
		}
	}
}

// The user docs keep the wording the messages keep (messages.test.ts).
func TestDocsKeepTheMessagesWording(t *testing.T) {
	var wording map[string][]struct{ Pattern, Why string }
	readJSON(t, "frontend/src/lib/i18n/wording.json", &wording)
	for _, doc := range []string{"README.md", "docs/using.md"} {
		text := blank(prose(read(t, doc)), `\]\([^)]*\)`)
		for _, rule := range wording["en"] {
			for _, m := range regexp.MustCompile(rule.Pattern).FindAllStringIndex(text, -1) {
				t.Errorf("%s:%d %q: %s", doc, line(text, m[0]), text[m[0]:m[1]], rule.Why)
			}
		}
	}
}

// messages is every text en.json or de.json can show, plural variants included.
func messages(t *testing.T, locale string) []string {
	var file map[string]any
	readJSON(t, "frontend/messages/"+locale+".json", &file)
	var out []string
	var walk func(any)
	walk = func(v any) {
		switch v := v.(type) {
		case string:
			out = append(out, v)
		case []any:
			for _, e := range v {
				walk(e)
			}
		case map[string]any:
			for k, e := range v {
				if k != "declarations" && k != "selectors" {
					walk(e)
				}
			}
		}
	}
	for key, message := range file {
		if !strings.HasPrefix(key, "$") {
			walk(message)
		}
	}
	return out
}

// serverSource is the backend's Go code, its tests left out.
func serverSource(t *testing.T) string {
	var b strings.Builder
	err := filepath.WalkDir(repoRoot+"backend", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && strings.HasPrefix(d.Name(), "pb_") {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		b.Write(src)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// prose is a Markdown text without its code, line numbers kept.
func prose(text string) string {
	return blank(blank(text, "(?s)```.*?```"), "`[^`]*`")
}

// unreleased is CHANGELOG.md's "## Unreleased" section alone, line numbers kept.
func unreleased(text string) string {
	start := strings.Index(text, "\n## Unreleased")
	if start < 0 {
		return blank(text, ".+")
	}
	end := len(text)
	if next := strings.Index(text[start+1:], "\n## "); next >= 0 {
		end = start + 1 + next
	}
	return blank(text[:start], ".+") + text[start:end] + blank(text[end:], ".+")
}

// blank empties each match of pattern in text but for its line breaks.
func blank(text, pattern string) string {
	return regexp.MustCompile(pattern).ReplaceAllStringFunc(text, func(m string) string {
		return strings.Repeat("\n", strings.Count(m, "\n"))
	})
}

func line(text string, offset int) int {
	return strings.Count(text[:offset], "\n") + 1
}

func read(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(repoRoot + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func readJSON(t *testing.T, name string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(read(t, name)), v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}
