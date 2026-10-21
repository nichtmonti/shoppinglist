package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"shoppinglist/internal/curate"
	"shoppinglist/internal/demo"
	"shoppinglist/internal/invites"
	"shoppinglist/internal/settings"
	"shoppinglist/internal/testutil/docblock"
	"shoppinglist/internal/upgradebackup"
)

// The numbers the operator docs quote outside a rendered table are the ones
// the code holds: each phrase is formatted from its source and must be in its
// file as it stands, a wrapped line included.
func TestDocsQuoteTheCode(t *testing.T) {
	app := newServeApp(t)
	backups := app.Settings().Backups
	accounts, err := app.FindCollectionByNameOrId("accounts")
	if err != nil {
		t.Fatal(err)
	}
	serve := settings.ServeDefaults()
	image := regexp.MustCompile(settings.DemoStartsPerIPEnv + `=(\d+)`).FindStringSubmatch(docblock.Read(t, "Dockerfile.demo"))
	if image == nil {
		t.Fatalf("Dockerfile.demo does not set %s", settings.DemoStartsPerIPEnv)
	}
	demoStarts, _ := strconv.Atoi(image[1])
	days := func(d time.Duration) int { return int(d.Hours() / 24) }

	for _, c := range []struct{ file, phrase string }{
		// The schedule migration 1778000024 sets.
		{"docs/operating.md", fmt.Sprintf("every night** at %s UTC, into `pb_data/backups/`, and keeps the newest %s.",
			dailyAt(t, backups.Cron), word(t, backups.CronMaxKeep))},
		{"docs/operating.md", fmt.Sprintf("It keeps the newest %s of those", word(t, upgradebackup.Keep))},
		{"docs/deploy-reference.md", fmt.Sprintf("The newest %s are kept.", word(t, upgradebackup.Keep))},
		{"docs/deploy-reference.md", fmt.Sprintf("Sessions are %d-day tokens", days(accounts.AuthToken.DurationTime()))},
		{"docs/deploy-reference.md", fmt.Sprintf("link lasts %d days", days(invites.Lifetime))},
		{"docs/deploy-reference.md", fmt.Sprintf("can join that list for %d days", days(invites.Lifetime))},
		{"docs/deploy-reference.md", fmt.Sprintf("(%d × %s items by default)", serve.MaxListsPerAccount, thousands(int(serve.MaxItemsPerList)))},
		// The :demo image's own starts per address.
		{"docs/deploy-reference.md", fmt.Sprintf("every account deleted after %d hours", int(demo.Lifetime.Hours()))},
		{"docs/deploy-reference.md", fmt.Sprintf("start %s demos per %d minutes", thousands(demoStarts), int(demo.StartWindow.Minutes()))},
		{"docs/operating.md", fmt.Sprintf("names seen on at least %d lists (`--min-lists N`)", curate.DefaultMinLists)},
	} {
		if !strings.Contains(docblock.Read(t, c.file), c.phrase) {
			t.Errorf("%s does not say %q", c.file, c.phrase)
		}
	}
}

// dailyAt is a daily cron expression's time, "03:00".
func dailyAt(t *testing.T, expr string) string {
	f := strings.Fields(expr)
	if len(f) != 5 || f[2] != "*" || f[3] != "*" || f[4] != "*" {
		t.Fatalf("%q is not a daily schedule", expr)
	}
	m, errM := strconv.Atoi(f[0])
	h, errH := strconv.Atoi(f[1])
	if errM != nil || errH != nil {
		t.Fatalf("%q is not a daily schedule", expr)
	}
	return fmt.Sprintf("%02d:%02d", h, m)
}

// word is a small count as the docs write it.
func word(t *testing.T, n int) string {
	words := []string{"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"}
	if n < 0 || n >= len(words) {
		t.Fatalf("no word for %d", n)
	}
	return words[n]
}

// thousands is n with a comma between its thousands, "5,000".
func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
