package settings

import (
	"flag"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the settings tables in docs/deploy-reference.md")

const docFile = "../../../docs/deploy-reference.md"

// A table's markers name the structs whose fields it lists, in order.
var tableBlock = regexp.MustCompile(`(?s)(<!-- settings table: ([A-Za-z ]+?) \(rendered from backend/internal/settings/settings\.go by its test\) -->\n)(.*?)(<!-- settings table end -->)`)

var types = map[string]reflect.Type{
	"Serve": reflect.TypeFor[Serve](),
	"Boot":  reflect.TypeFor[Boot](),
	"Demo":  reflect.TypeFor[Demo](),
}

// [D-337] Each table in docs/deploy-reference.md is the one this file's
// declarations render; -update rewrites them.
func TestSettingsTables(t *testing.T) {
	docs := fieldDocs(t)
	raw, err := os.ReadFile(docFile)
	if err != nil {
		t.Fatal(err)
	}
	blocks := tableBlock.FindAllStringSubmatchIndex(string(raw), -1)
	if len(blocks) == 0 {
		t.Fatalf("%s has no settings table markers", docFile)
	}
	out, last := []byte{}, 0
	for _, b := range blocks {
		structs := strings.Fields(string(raw[b[4]:b[5]]))
		out = append(out, raw[last:b[6]]...)
		out = append(out, renderTable(t, structs, docs)...)
		last = b[7]
	}
	out = append(out, raw[last:]...)
	if string(out) == string(raw) {
		return
	}
	if *update {
		if err := os.WriteFile(docFile, out, 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	t.Errorf("the settings tables in docs/deploy-reference.md are stale: go test ./internal/settings -update")
}

// The values the defaults column quotes from elsewhere: what .env.example
// sets, and what the :demo image sets (an ENV line may continue over several).
var (
	exampleSets = assignments(t0(os.ReadFile("../../../.env.example")), `(?m)^([A-Z_][A-Z0-9_]*)=(\S*)`)
	imageSets   = assignments(strings.ReplaceAll(t0(os.ReadFile("../../../Dockerfile.demo")), "\\\n", " "),
		`([A-Z_][A-Z0-9_]*)=(\S+)`)
	quotesExample = regexp.MustCompile("`\\.env\\.example`: `([^`]*)`")
	quotesImage   = regexp.MustCompile("`([^`]*)` in the image")
)

func t0(b []byte, err error) string {
	if err != nil {
		panic(err)
	}
	return string(b)
}

func assignments(text, pattern string) map[string]string {
	m := map[string]string{}
	for _, a := range regexp.MustCompile(pattern).FindAllStringSubmatch(text, -1) {
		m[a[1]] = a[2]
	}
	return m
}

// checkDefault holds what the defaults column says to what holds elsewhere.
func checkDefault(t *testing.T, f reflect.StructField, variable, def string) {
	t.Helper()
	if code, ok := f.Tag.Lookup("envDefault"); ok && !strings.Contains(def, "`"+code+"`") {
		t.Errorf("%s: the docs' default %q does not show the code's %q", variable, def, code)
	}
	if f.Type == reflect.TypeFor[*OnOff]() && def != "`off`" {
		t.Errorf("%s: an unset switch reads as off (OnOff.On), the docs say %q", variable, def)
	}
	if m := quotesExample.FindStringSubmatch(def); m != nil && exampleSets[variable] != m[1] {
		t.Errorf("%s: the docs quote .env.example as %q, it sets %q", variable, m[1], exampleSets[variable])
	}
	if m := quotesImage.FindStringSubmatch(def); m != nil && imageSets[variable] != m[1] {
		t.Errorf("%s: the docs quote the image as %q, Dockerfile.demo sets %q", variable, m[1], imageSets[variable])
	}
}

func renderTable(t *testing.T, structs []string, docs map[string]string) string {
	var b strings.Builder
	b.WriteString("| Variable | Default | What it does |\n|---|---|---|\n")
	for _, name := range structs {
		typ, ok := types[name]
		if !ok {
			t.Fatalf("a table names %q, which is no settings struct", name)
		}
		for f := range typ.Fields() {
			doc := docs[name+"."+f.Name]
			if doc == "" {
				t.Errorf("%s.%s has no doc comment: the table would say nothing", name, f.Name)
			}
			help, def := splitDefault(doc)
			variable := f.Tag.Get("env")
			if f.Type.Kind() == reflect.Struct {
				// One row for a group: its comment names each member.
				variable = f.Tag.Get("doc")
				for field := range f.Type.Fields() {
					if member := "`" + field.Tag.Get("env") + "`"; !strings.Contains(help, member) {
						t.Errorf("%s.%s's comment does not name %s", name, f.Name, member)
					}
				}
			}
			if code, ok := f.Tag.Lookup("envDefault"); ok && def == "" {
				def = "`" + code + "`"
			}
			checkDefault(t, f, variable, def)
			b.WriteString("| `" + variable + "` | " + def + " | " + help + " |\n")
		}
	}
	return b.String()
}

// splitDefault takes a last paragraph "Default: …" off a comment.
func splitDefault(doc string) (help, def string) {
	paras := strings.Split(strings.TrimSpace(doc), "\n\n")
	if d, ok := strings.CutPrefix(paras[len(paras)-1], "Default: "); ok {
		def, paras = d, paras[:len(paras)-1]
	}
	return strings.Join(strings.Fields(strings.Join(paras, " ")), " "), def
}

// fieldDocs is each struct field's doc comment in settings.go, by
// "Struct.Field".
func fieldDocs(t *testing.T) map[string]string {
	file, err := parser.ParseFile(token.NewFileSet(), "settings.go", nil, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	docs := map[string]string{}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.TypeSpec)
		if !ok {
			return true
		}
		if st, ok := spec.Type.(*ast.StructType); ok {
			for _, f := range st.Fields.List {
				for _, name := range f.Names {
					docs[spec.Name.Name+"."+name.Name] = f.Doc.Text()
				}
			}
		}
		return false
	})
	return docs
}

// The name constants are exactly the tags: one per setting, the same text.
func TestConstantsAreTheTags(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "settings.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	consts := map[string]string{}
	for _, d := range file.Decls {
		if g, ok := d.(*ast.GenDecl); ok && g.Tok == token.CONST {
			for _, spec := range g.Specs {
				v := spec.(*ast.ValueSpec)
				if lit, ok := v.Values[0].(*ast.BasicLit); ok && strings.HasSuffix(v.Names[0].Name, "Env") {
					consts[strings.Trim(lit.Value, `"`)] = v.Names[0].Name
				}
			}
		}
	}
	tags := map[string]bool{}
	for _, name := range Names() {
		tags[name] = true
		if consts[name] == "" {
			t.Errorf("%s has no name constant", name)
		}
	}
	for value, name := range consts {
		if !tags[value] {
			t.Errorf("%s = %q is no setting's tag", name, value)
		}
	}
}
