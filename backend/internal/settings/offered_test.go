package settings

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/caarlos0/env/v11"
)

// The repository's root, from this package.
const repoRoot = "../../../"

// The operator's files hold to the settings the server reads ([D-337]). The
// compose file hands .env to the app whole ([D-263]), so what an operator can
// set is what .env.example offers and the deployment reference explains: a
// setting the code reads but neither names is one nobody finds, and a name
// .env.example offers that nothing reads does nothing. The demo build's own
// settings are not offered in .env.example, which runs the real image.
func TestDocsOperatorFilesOfferTheSettings(t *testing.T) {
	server := slices.Concat(keys(t, &Serve{}), keys(t, &Boot{}))
	demo := keys(t, &Demo{})
	compose := readRepo(t, "docker-compose.yml")
	interpolated := matches(compose, `\$\{([A-Z_][A-Z0-9_]*)`)

	// The service hands over .env and maps no setting itself: environment:
	// wins over env_file, so a mapping would shadow .env. The proxy variables
	// are Go's net/http's.
	service := regexp.MustCompile(`(?m)^ {2}shoppinglist:\n((?: {4}.*\n|\s*\n)*)`).FindStringSubmatch(compose)
	if service == nil || !regexp.MustCompile(`(?m)^ {4}env_file: \.env$`).MatchString(service[1]) {
		t.Error("docker-compose.yml: the shoppinglist service does not hand over .env (env_file: .env)")
	}
	if service != nil {
		if block := regexp.MustCompile(`(?m)^ {4}environment:\n((?: {6}.*\n|\s*\n)*)`).FindStringSubmatch(service[1]); block != nil {
			for _, name := range matches(block[1], `(?m)^ {6}([A-Z_][A-Z0-9_]*):`) {
				if !slices.Contains([]string{"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"}, name) {
					t.Errorf("docker-compose.yml maps %s itself; .env hands it over, so leave it to env_file", name)
				}
			}
		}
	}

	// Every setting the server reads is offered, set or commented out, but
	// the hand-set OIDC endpoints, for the rare provider without discovery
	// ([D-210]); every name offered is read by the server or by compose.
	referenceOnly := []string{OIDCAuthURLEnv, OIDCTokenURLEnv, OIDCUserinfoURLEnv}
	offered := matches(readRepo(t, ".env.example"), `(?m)^#?\s*([A-Z_][A-Z0-9_]*)=`)
	for _, name := range server {
		if !slices.Contains(offered, name) && !slices.Contains(referenceOnly, name) {
			t.Errorf(".env.example does not offer %s, which the server reads", name)
		}
	}
	for _, name := range offered {
		if !slices.Contains(server, name) && !slices.Contains(interpolated, name) {
			t.Errorf(".env.example offers %s, which neither the server nor compose reads", name)
		}
	}

	// The README carries the compose file verbatim, so a copy of it runs.
	if !strings.Contains(readRepo(t, "README.md"), "```yaml\n"+compose+"```\n") {
		t.Error("README.md: its compose block is not docker-compose.yml verbatim; copy the file in")
	}

	reference := readRepo(t, "docs/deploy-reference.md")
	for _, name := range slices.Concat(server, demo, interpolated) {
		if !regexp.MustCompile(`(^|[^A-Z0-9_])` + name + `([^A-Z0-9_]|$)`).MatchString(reference) {
			t.Errorf("docs/deploy-reference.md does not mention %s", name)
		}
	}

	// Others passes exactly compose's own, then the tooling's ([D-336]).
	for _, name := range interpolated {
		if strings.HasPrefix(name, "SHOPPINGLIST_") && !slices.Contains(composeNames, name) {
			t.Errorf("composeNames does not pass %s, which docker-compose.yml fills in", name)
		}
	}
	for _, name := range composeNames {
		if !slices.Contains(interpolated, name) {
			t.Errorf("composeNames passes %s, which docker-compose.yml does not read", name)
		}
	}
	for _, name := range toolingNames {
		if slices.Contains(server, name) || slices.Contains(demo, name) {
			t.Errorf("toolingNames lists the setting %s", name)
		}
	}
}

// A setting is read through this package or not at all: no other server code
// names a SHOPPINGLIST_ variable this package does not declare.
func TestNoSettingIsReadPastThisPackage(t *testing.T) {
	known := slices.Concat(Names(), Others)
	quoted := regexp.MustCompile(`"(SHOPPINGLIST_[A-Z0-9_]*[A-Z0-9])"`)
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
		if err != nil {
			return err
		}
		for _, m := range quoted.FindAllStringSubmatch(string(src), -1) {
			if !slices.Contains(known, m[1]) {
				t.Errorf("%s names %s, which internal/settings does not declare", strings.TrimPrefix(path, repoRoot), m[1])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func keys(t *testing.T, v any) []string {
	t.Helper()
	params, err := env.GetFieldParams(v)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range params {
		names = append(names, p.Key)
	}
	return names
}

func readRepo(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(repoRoot + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// matches is each first group of pattern in text, once.
func matches(text, pattern string) []string {
	var out []string
	for _, m := range regexp.MustCompile(pattern).FindAllStringSubmatch(text, -1) {
		if !slices.Contains(out, m[1]) {
			out = append(out, m[1])
		}
	}
	return out
}
