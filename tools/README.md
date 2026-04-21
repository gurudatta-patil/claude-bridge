# Stitch Type Generation Tools

This directory contains tools that auto-generate request/response type definitions across language boundaries in the Stitch cross-language IPC framework. Each tool targets a specific source-to-target language pair.

---

## Tools

### 1. `pydantic-to-ts/` — Pydantic Models → TypeScript Interfaces + Zod Validators

**What it does**

Reads one or more Python source files, discovers all `pydantic.BaseModel` subclasses, and emits:
- TypeScript `interface` declarations (or `type` aliases for unions)
- Zod schema validators with `z.infer<>` type aliases, enabling runtime validation in the TypeScript client

**When to use it**

Use this tool when the Python sidecar defines the canonical data shapes (e.g. FastAPI / raw `pydantic` models) and the TypeScript host needs matching types to call into the sidecar through a Stitch bridge.

**Quick start**

```bash
cd tools/pydantic-to-ts
pip install pydantic
python pydantic_to_ts.py ../../languages/python/models.py --out ../../languages/typescript/generated/models.ts
```

**CLI flags**

| Flag | Default | Description |
|------|---------|-------------|
| `files...` | required | One or more `.py` files to inspect |
| `--out PATH` | stdout | Destination `.ts` file |
| `--zod` / `--no-zod` | `--zod` | Whether to emit Zod schemas alongside interfaces |

See `pydantic-to-ts/pydantic_to_ts.py` for the full implementation.

---

### 2. `go-gen-python-stubs/` — Go Handler Structs → Python `.pyi` Type Stubs

**What it does**

Parses a Go source file with `go/ast`, finds all struct types annotated with JSON struct tags, and generates:
- A `.pyi` stub file using `TypedDict` for use with mypy / Pylance without runtime overhead
- Optionally a `.py` file with `pydantic.BaseModel` definitions for runtime validation

**When to use it**

Use this when the Go sidecar owns the request/response structs and the Python host (or another Python component) needs typed representations to pass over the Stitch bridge.

**Quick start**

```bash
cd tools/go-gen-python-stubs
go run main.go -in ../../languages/go/sidecar/main.go -out stubs.pyi -style typeddict
# or for Pydantic output:
go run main.go -in ../../languages/go/sidecar/main.go -out models.py -style pydantic
```

**CLI flags**

| Flag | Default | Description |
|------|---------|-------------|
| `-in PATH` | required | Go source file to parse |
| `-out PATH` | stdout | Destination `.pyi` or `.py` file |
| `-style` | `typeddict` | Output style: `typeddict` or `pydantic` |

**Type mapping**

| Go | Python |
|----|--------|
| `string` | `str` |
| `int`, `int32`, `int64` | `int` |
| `float32`, `float64` | `float` |
| `bool` | `bool` |
| `[]T` | `list[T]` |
| `map[string]T` | `dict[str, T]` |
| `*T` | `Optional[T]` |
| `json:",omitempty"` | `NotRequired[T]` (TypedDict) |

See `go-gen-python-stubs/main.go` for the full implementation.

---

### 3. `ts-rs-export/` — Rust Structs → TypeScript (via `ts-rs`)

**What it does**

Documents how to use the [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) crate to derive TypeScript type exports directly from Rust structs in a Stitch sidecar. Unlike the other tools here, `ts-rs` is a compile-time derive macro — no separate codegen binary is needed.

**When to use it**

Use this approach when the Rust sidecar defines the canonical types and the TypeScript client needs matching interfaces. `ts-rs` keeps the Rust source as the single source of truth and re-exports types automatically on every `cargo test` or via `build.rs`.

**Quick start**

1. Add `ts-rs` to the Rust sidecar's `Cargo.toml`
2. Annotate structs with `#[derive(TS)]` and `#[ts(export)]`
3. Run `cargo test export_bindings` to generate `bindings/*.ts`
4. Import the generated types in the TypeScript host

See `ts-rs-export/README.md` for the step-by-step guide.

---

## Choosing the Right Tool

| Scenario | Tool |
|----------|------|
| Python owns types, TypeScript consumes them | `pydantic-to-ts` |
| Go owns types, Python consumes them | `go-gen-python-stubs` |
| Rust owns types, TypeScript consumes them | `ts-rs-export` |
| Go owns types, TypeScript consumes them | Adapt `go-gen-python-stubs` output → feed into `pydantic-to-ts`, or write a thin wrapper |

## Contributing

Each tool lives in its own subdirectory with its own dependencies. Run tools independently; they have no shared runtime. Follow the existing naming convention (`{source}-to-{target}` or `{source}-gen-{target}-stubs`) when adding new tools.
