"""
pydantic_to_ts.py — Convert Pydantic BaseModel subclasses to TypeScript interfaces
                    and (optionally) Zod validators.

Usage:
    python pydantic_to_ts.py models.py --out generated.ts
    python pydantic_to_ts.py models.py other.py --out generated.ts --no-zod

The script dynamically imports the supplied Python files, discovers every
pydantic.BaseModel subclass defined in those files, calls .model_json_schema()
on each one, and emits TypeScript interface declarations plus Zod schemas.
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import sys
import textwrap
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# JSON Schema → TypeScript type string
# ---------------------------------------------------------------------------

def _resolve_ref(ref: str, defs: dict[str, Any]) -> dict[str, Any]:
    """Dereference a $ref like '#/$defs/Foo' to the actual schema dict."""
    if ref.startswith("#/$defs/"):
        name = ref[len("#/$defs/"):]
        return defs.get(name, {})
    return {}


def schema_to_ts_type(
    schema: dict[str, Any],
    defs: dict[str, Any],
    indent: int = 0,
) -> str:
    """Recursively convert a JSON Schema node to a TypeScript type string."""

    # $ref — always prefer the referenced name so we get cross-references right
    if "$ref" in schema:
        ref = schema["$ref"]
        if ref.startswith("#/$defs/"):
            return ref[len("#/$defs/"):]
        return "unknown"

    # anyOf / oneOf → union
    if "anyOf" in schema or "oneOf" in schema:
        variants = schema.get("anyOf", schema.get("oneOf", []))
        # Pydantic emits `anyOf: [{type: X}, {type: 'null'}]` for Optional[X]
        non_null = [v for v in variants if v.get("type") != "null"]
        if len(non_null) == 1 and len(variants) == 2:
            return f"{schema_to_ts_type(non_null[0], defs, indent)} | null"
        parts = [schema_to_ts_type(v, defs, indent) for v in variants]
        return " | ".join(parts)

    # allOf with a single entry — Pydantic uses this for nested model refs
    if "allOf" in schema:
        entries = schema["allOf"]
        if len(entries) == 1:
            return schema_to_ts_type(entries[0], defs, indent)
        parts = [schema_to_ts_type(e, defs, indent) for e in entries]
        return " & ".join(parts)

    type_ = schema.get("type")

    if type_ == "string":
        if "enum" in schema:
            return " | ".join(f'"{v}"' for v in schema["enum"])
        return "string"

    if type_ in ("number", "integer"):
        return "number"

    if type_ == "boolean":
        return "boolean"

    if type_ == "null":
        return "null"

    if type_ == "array":
        items = schema.get("items", {})
        inner = schema_to_ts_type(items, defs, indent)
        return f"Array<{inner}>"

    if type_ == "object":
        properties = schema.get("properties")
        if not properties:
            additional = schema.get("additionalProperties")
            if additional:
                val_type = schema_to_ts_type(additional, defs, indent)
                return f"Record<string, {val_type}>"
            return "Record<string, unknown>"

        required_set = set(schema.get("required", []))
        pad = "  " * (indent + 1)
        lines = ["{"]
        for prop_name, prop_schema in properties.items():
            ts_type = schema_to_ts_type(prop_schema, defs, indent + 1)
            opt = "" if prop_name in required_set else "?"
            lines.append(f"{pad}{prop_name}{opt}: {ts_type};")
        lines.append("  " * indent + "}")
        return "\n".join(lines)

    # Fallback
    return "unknown"


# ---------------------------------------------------------------------------
# JSON Schema → Zod validator string
# ---------------------------------------------------------------------------

def schema_to_zod(
    schema: dict[str, Any],
    defs: dict[str, Any],
) -> str:
    """Recursively convert a JSON Schema node to a Zod expression string."""

    if "$ref" in schema:
        ref = schema["$ref"]
        if ref.startswith("#/$defs/"):
            name = ref[len("#/$defs/"):]
            return f"{name}Schema"
        return "z.unknown()"

    if "anyOf" in schema or "oneOf" in schema:
        variants = schema.get("anyOf", schema.get("oneOf", []))
        non_null = [v for v in variants if v.get("type") != "null"]
        if len(non_null) == 1 and len(variants) == 2:
            return f"{schema_to_zod(non_null[0], defs)}.nullable()"
        parts = [schema_to_zod(v, defs) for v in variants]
        return f"z.union([{', '.join(parts)}])"

    if "allOf" in schema:
        entries = schema["allOf"]
        if len(entries) == 1:
            return schema_to_zod(entries[0], defs)
        parts = [schema_to_zod(e, defs) for e in entries]
        # Zod intersection
        result = parts[0]
        for p in parts[1:]:
            result = f"{result}.and({p})"
        return result

    type_ = schema.get("type")

    if type_ == "string":
        if "enum" in schema:
            values = ", ".join(f'"{v}"' for v in schema["enum"])
            return f"z.enum([{values}])"
        return "z.string()"

    if type_ == "integer":
        return "z.number().int()"

    if type_ == "number":
        return "z.number()"

    if type_ == "boolean":
        return "z.boolean()"

    if type_ == "null":
        return "z.null()"

    if type_ == "array":
        items = schema.get("items", {})
        return f"z.array({schema_to_zod(items, defs)})"

    if type_ == "object":
        properties = schema.get("properties")
        if not properties:
            additional = schema.get("additionalProperties")
            if additional:
                return f"z.record(z.string(), {schema_to_zod(additional, defs)})"
            return "z.record(z.string(), z.unknown())"

        required_set = set(schema.get("required", []))
        field_lines = []
        for prop_name, prop_schema in properties.items():
            zod_expr = schema_to_zod(prop_schema, defs)
            if prop_name not in required_set:
                zod_expr = f"{zod_expr}.optional()"
            field_lines.append(f"  {prop_name}: {zod_expr},")
        inner = "\n".join(field_lines)
        return f"z.object({{\n{inner}\n}})"

    return "z.unknown()"


# ---------------------------------------------------------------------------
# Top-level model → TypeScript interface
# ---------------------------------------------------------------------------

def model_to_ts_interface(name: str, schema: dict[str, Any]) -> str:
    """Render a single Pydantic model's JSON Schema as a TypeScript interface."""
    defs = schema.get("$defs", {})
    properties = schema.get("properties", {})
    required_set = set(schema.get("required", []))

    lines = [f"export interface {name} {{"]
    for prop_name, prop_schema in properties.items():
        ts_type = schema_to_ts_type(prop_schema, defs)
        opt = "" if prop_name in required_set else "?"
        lines.append(f"  {prop_name}{opt}: {ts_type};")
    lines.append("}")
    return "\n".join(lines)


def model_to_zod_schema(name: str, schema: dict[str, Any]) -> str:
    """Render a Pydantic model's JSON Schema as a Zod schema + inferred type."""
    defs = schema.get("$defs", {})
    properties = schema.get("properties", {})
    required_set = set(schema.get("required", []))

    field_lines = []
    for prop_name, prop_schema in properties.items():
        zod_expr = schema_to_zod(prop_schema, defs)
        if prop_name not in required_set:
            zod_expr = f"{zod_expr}.optional()"
        field_lines.append(f"  {prop_name}: {zod_expr},")

    inner = "\n".join(field_lines)
    schema_var = f"{name}Schema"
    return (
        f"export const {schema_var} = z.object({{\n{inner}\n}});\n"
        f"export type {name} = z.infer<typeof {schema_var}>;"
    )


def defs_to_ts(defs: dict[str, Any], emit_zod: bool) -> list[str]:
    """Convert $defs (nested models) from a JSON Schema to TS/Zod blocks."""
    blocks: list[str] = []
    for def_name, def_schema in defs.items():
        if emit_zod:
            blocks.append(model_to_zod_schema(def_name, def_schema))
        else:
            blocks.append(model_to_ts_interface(def_name, def_schema))
    return blocks


# ---------------------------------------------------------------------------
# Dynamic import helpers
# ---------------------------------------------------------------------------

def load_module_from_file(path: Path):
    """Import a Python file as a module without polluting sys.modules permanently."""
    module_name = f"_pydantic_to_ts_{path.stem}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)  # type: ignore[attr-defined]
    return module


def find_pydantic_models(module) -> list[type]:
    """Return all pydantic BaseModel subclasses defined in *module* (not imported)."""
    try:
        from pydantic import BaseModel
    except ImportError:
        print(
            "ERROR: pydantic is not installed. Run: pip install pydantic",
            file=sys.stderr,
        )
        sys.exit(1)

    models = []
    for _, obj in inspect.getmembers(module, inspect.isclass):
        if (
            issubclass(obj, BaseModel)
            and obj is not BaseModel
            and obj.__module__ == module.__name__
        ):
            models.append(obj)
    return models


# ---------------------------------------------------------------------------
# Code generation entry point
# ---------------------------------------------------------------------------

def generate(input_paths: list[Path], emit_zod: bool) -> str:
    """Discover models from *input_paths* and return the full TypeScript output."""
    try:
        from pydantic import BaseModel  # noqa: F401 — ensure pydantic is importable
    except ImportError:
        print(
            "ERROR: pydantic is not installed. Run: pip install pydantic",
            file=sys.stderr,
        )
        sys.exit(1)

    source_names = ", ".join(p.name for p in input_paths)
    header_lines = [
        "// ============================================================",
        f"// Auto-generated by pydantic_to_ts.py",
        f"// Source: {source_names}",
        "// DO NOT EDIT — regenerate with:",
        f"//   python pydantic_to_ts.py {' '.join(str(p) for p in input_paths)}",
        "// ============================================================",
        "",
    ]

    if emit_zod:
        header_lines += ['import { z } from "zod";', ""]

    blocks: list[str] = list(header_lines)

    # Track already-emitted def names to avoid duplicates across files
    emitted_defs: set[str] = set()

    for path in input_paths:
        module = load_module_from_file(path)
        models = find_pydantic_models(module)

        if not models:
            blocks.append(f"// No BaseModel subclasses found in {path.name}")
            blocks.append("")
            continue

        blocks.append(f"// --- {path.name} ---")
        blocks.append("")

        for model_cls in models:
            schema = model_cls.model_json_schema()
            defs = schema.get("$defs", {})

            # Emit nested $defs first (dependency order)
            for def_name, def_schema in defs.items():
                if def_name not in emitted_defs:
                    emitted_defs.add(def_name)
                    if emit_zod:
                        blocks.append(model_to_zod_schema(def_name, def_schema))
                    else:
                        blocks.append(model_to_ts_interface(def_name, def_schema))
                    blocks.append("")

            # Emit the top-level model
            if emit_zod:
                blocks.append(model_to_zod_schema(model_cls.__name__, schema))
            else:
                blocks.append(model_to_ts_interface(model_cls.__name__, schema))
            blocks.append("")

    return "\n".join(blocks)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert Pydantic BaseModel subclasses to TypeScript interfaces and Zod validators.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """\
            Examples:
              python pydantic_to_ts.py models.py --out generated.ts
              python pydantic_to_ts.py models.py other.py --out out.ts --no-zod
            """
        ),
    )
    parser.add_argument(
        "files",
        metavar="FILE",
        nargs="+",
        type=Path,
        help="Python source files containing Pydantic models",
    )
    parser.add_argument(
        "--out",
        metavar="PATH",
        type=Path,
        default=None,
        help="Output .ts file path (default: stdout)",
    )
    parser.add_argument(
        "--zod",
        dest="zod",
        action="store_true",
        default=True,
        help="Emit Zod schemas (default: on)",
    )
    parser.add_argument(
        "--no-zod",
        dest="zod",
        action="store_false",
        help="Emit plain TypeScript interfaces only (no Zod)",
    )

    args = parser.parse_args()

    # Validate inputs
    for p in args.files:
        if not p.exists():
            print(f"ERROR: File not found: {p}", file=sys.stderr)
            sys.exit(1)
        if p.suffix != ".py":
            print(f"WARNING: {p} does not have a .py extension", file=sys.stderr)

    output = generate(args.files, emit_zod=args.zod)

    if args.out is None:
        print(output)
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(output, encoding="utf-8")
        print(f"Written to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
