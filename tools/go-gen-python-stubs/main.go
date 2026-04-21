// go-gen-python-stubs — Generate Python TypedDict or Pydantic BaseModel stubs
// from Go struct types that carry JSON struct tags.
//
// Usage:
//
//	go run main.go -in ./sidecar/main.go -out stubs.pyi -style typeddict
//	go run main.go -in ./sidecar/main.go -out models.py  -style pydantic
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strings"
)

// ---------------------------------------------------------------------------
// Type mapping: Go → Python
// ---------------------------------------------------------------------------

// goTypeToPython converts a Go AST expression to a Python type annotation
// string. The omitempty flag controls whether the result is wrapped in
// NotRequired[...] for TypedDict output.
func goTypeToPython(expr ast.Expr, style string, omitempty bool) string {
	raw := goExprToPython(expr, style)
	if omitempty && style == "typeddict" {
		return fmt.Sprintf("NotRequired[%s]", raw)
	}
	return raw
}

func goExprToPython(expr ast.Expr, style string) string {
	if expr == nil {
		return "Any"
	}

	switch t := expr.(type) {
	case *ast.Ident:
		return primitiveMap(t.Name)

	case *ast.StarExpr:
		inner := goExprToPython(t.X, style)
		return fmt.Sprintf("Optional[%s]", inner)

	case *ast.ArrayType:
		inner := goExprToPython(t.Elt, style)
		return fmt.Sprintf("list[%s]", inner)

	case *ast.MapType:
		key := goExprToPython(t.Key, style)
		val := goExprToPython(t.Value, style)
		return fmt.Sprintf("dict[%s, %s]", key, val)

	case *ast.SelectorExpr:
		// e.g. time.Time, json.RawMessage
		pkg := ""
		if ident, ok := t.X.(*ast.Ident); ok {
			pkg = ident.Name
		}
		return qualifiedMap(pkg, t.Sel.Name)

	case *ast.InterfaceType:
		return "Any"

	case *ast.StructType:
		// Inline anonymous struct — treat as dict
		return "dict[str, Any]"
	}

	return "Any"
}

func primitiveMap(goType string) string {
	switch goType {
	case "string":
		return "str"
	case "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64",
		"byte", "rune":
		return "int"
	case "float32", "float64":
		return "float"
	case "bool":
		return "bool"
	case "error":
		return "str"
	default:
		// Assume it's a locally defined struct — keep the name as-is
		return goType
	}
}

func qualifiedMap(pkg, name string) string {
	switch pkg + "." + name {
	case "time.Time":
		return "str" // ISO-8601 string over JSON
	case "json.RawMessage":
		return "Any"
	default:
		return name
	}
}

// ---------------------------------------------------------------------------
// JSON tag parsing
// ---------------------------------------------------------------------------

type fieldMeta struct {
	jsonName  string // name as it appears in JSON
	omitempty bool
	skip      bool // json:"-"
}

func parseJSONTag(tag string) fieldMeta {
	// tag is the raw struct tag value, e.g.:  `json:"name,omitempty" db:"name"`
	// reflect.StructTag lets us extract the json portion cleanly.
	st := reflect.StructTag(tag)
	jsonVal := st.Get("json")

	if jsonVal == "" {
		return fieldMeta{}
	}

	parts := strings.Split(jsonVal, ",")
	name := parts[0]

	if name == "-" {
		return fieldMeta{skip: true}
	}

	meta := fieldMeta{jsonName: name}
	for _, opt := range parts[1:] {
		if opt == "omitempty" {
			meta.omitempty = true
		}
	}
	return meta
}

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

// structField represents one field extracted from a Go struct.
type structField struct {
	name      string
	pyType    string
	omitempty bool
}

// goStruct is a Go struct that has at least one JSON-tagged field.
type goStruct struct {
	name   string
	fields []structField
}

// extractStructs walks an AST file and returns every struct type that has at
// least one field with a JSON struct tag.
func extractStructs(file *ast.File, style string) []goStruct {
	var result []goStruct

	ast.Inspect(file, func(n ast.Node) bool {
		typeSpec, ok := n.(*ast.TypeSpec)
		if !ok {
			return true
		}
		structType, ok := typeSpec.Type.(*ast.StructType)
		if !ok {
			return true
		}

		var fields []structField
		for _, field := range structType.Fields.List {
			// Skip embedded / anonymous fields without names
			if len(field.Names) == 0 {
				continue
			}

			var meta fieldMeta
			if field.Tag != nil {
				// Strip surrounding backticks that the AST retains
				rawTag := strings.Trim(field.Tag.Value, "`")
				meta = parseJSONTag(rawTag)
			}

			if meta.skip {
				continue
			}

			pyType := goTypeToPython(field.Type, style, meta.omitempty)

			for _, nameIdent := range field.Names {
				jsonName := meta.jsonName
				if jsonName == "" {
					// No JSON tag — use the Go field name as-is
					jsonName = nameIdent.Name
				}
				fields = append(fields, structField{
					name:      jsonName,
					pyType:    pyType,
					omitempty: meta.omitempty,
				})
			}
		}

		// Only include structs that have at least one JSON-tagged or named field
		if len(fields) > 0 {
			result = append(result, goStruct{
				name:   typeSpec.Name.Name,
				fields: fields,
			})
		}
		return true
	})

	return result
}

// ---------------------------------------------------------------------------
// Code generation: TypedDict (.pyi)
// ---------------------------------------------------------------------------

func renderTypedDict(structs []goStruct, sourceFile string) string {
	var sb strings.Builder

	sb.WriteString("# ============================================================\n")
	sb.WriteString("# Auto-generated by go-gen-python-stubs\n")
	fmt.Fprintf(&sb, "# Source: %s\n", sourceFile)
	sb.WriteString("# DO NOT EDIT — regenerate with:\n")
	fmt.Fprintf(&sb, "#   go run main.go -in %s -out stubs.pyi -style typeddict\n", sourceFile)
	sb.WriteString("# ============================================================\n")
	sb.WriteString("\n")
	sb.WriteString("from __future__ import annotations\n")
	sb.WriteString("\n")
	sb.WriteString("from typing import Any, Dict, List, Optional\n")
	sb.WriteString("from typing_extensions import NotRequired, TypedDict\n")
	sb.WriteString("\n\n")

	for i, s := range structs {
		fmt.Fprintf(&sb, "class %s(TypedDict):\n", s.name)
		if len(s.fields) == 0 {
			sb.WriteString("    pass\n")
		} else {
			for _, f := range s.fields {
				fmt.Fprintf(&sb, "    %s: %s\n", f.name, f.pyType)
			}
		}
		if i < len(structs)-1 {
			sb.WriteString("\n\n")
		}
	}

	sb.WriteString("\n")
	return sb.String()
}

// ---------------------------------------------------------------------------
// Code generation: Pydantic BaseModel (.py)
// ---------------------------------------------------------------------------

func renderPydantic(structs []goStruct, sourceFile string) string {
	var sb strings.Builder

	sb.WriteString("# ============================================================\n")
	sb.WriteString("# Auto-generated by go-gen-python-stubs\n")
	fmt.Fprintf(&sb, "# Source: %s\n", sourceFile)
	sb.WriteString("# DO NOT EDIT — regenerate with:\n")
	fmt.Fprintf(&sb, "#   go run main.go -in %s -out models.py -style pydantic\n", sourceFile)
	sb.WriteString("# ============================================================\n")
	sb.WriteString("\n")
	sb.WriteString("from __future__ import annotations\n")
	sb.WriteString("\n")
	sb.WriteString("from typing import Any, Dict, List, Optional\n")
	sb.WriteString("from pydantic import BaseModel\n")
	sb.WriteString("\n\n")

	for i, s := range structs {
		fmt.Fprintf(&sb, "class %s(BaseModel):\n", s.name)
		if len(s.fields) == 0 {
			sb.WriteString("    pass\n")
		} else {
			for _, f := range s.fields {
				pyType := f.pyType
				// In Pydantic, omitempty fields become Optional with None default
				if f.omitempty {
					// Strip NotRequired wrapper added for TypedDict — Pydantic
					// uses Optional[T] = None instead.
					inner := strings.TrimPrefix(pyType, "NotRequired[")
					inner = strings.TrimSuffix(inner, "]")
					fmt.Fprintf(&sb, "    %s: Optional[%s] = None\n", f.name, inner)
				} else {
					fmt.Fprintf(&sb, "    %s: %s\n", f.name, pyType)
				}
			}
		}
		if i < len(structs)-1 {
			sb.WriteString("\n\n")
		}
	}

	sb.WriteString("\n")
	return sb.String()
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

func main() {
	inPath := flag.String("in", "", "Go source file to parse (required)")
	outPath := flag.String("out", "", "Output file path (default: stdout)")
	style := flag.String("style", "typeddict", "Output style: typeddict or pydantic")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "go-gen-python-stubs — Generate Python type stubs from Go structs with JSON tags")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Usage:")
		fmt.Fprintln(os.Stderr, "  go run main.go -in ./sidecar/main.go -out stubs.pyi -style typeddict")
		fmt.Fprintln(os.Stderr, "  go run main.go -in ./sidecar/main.go -out models.py -style pydantic")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Flags:")
		flag.PrintDefaults()
	}
	flag.Parse()

	if *inPath == "" {
		fmt.Fprintln(os.Stderr, "ERROR: -in is required")
		flag.Usage()
		os.Exit(1)
	}

	if *style != "typeddict" && *style != "pydantic" {
		fmt.Fprintf(os.Stderr, "ERROR: -style must be 'typeddict' or 'pydantic', got %q\n", *style)
		os.Exit(1)
	}

	// Parse the Go source file
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, *inPath, nil, parser.ParseComments)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: failed to parse %s: %v\n", *inPath, err)
		os.Exit(1)
	}

	structs := extractStructs(file, *style)

	if len(structs) == 0 {
		fmt.Fprintf(os.Stderr, "WARNING: no structs with JSON tags found in %s\n", *inPath)
	}

	var output string
	switch *style {
	case "pydantic":
		output = renderPydantic(structs, *inPath)
	default:
		output = renderTypedDict(structs, *inPath)
	}

	if *outPath == "" {
		fmt.Print(output)
	} else {
		if err := os.WriteFile(*outPath, []byte(output), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: failed to write %s: %v\n", *outPath, err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Written to %s\n", *outPath)
	}
}
