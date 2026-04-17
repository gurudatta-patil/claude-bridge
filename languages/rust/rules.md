# Language Rules — Rust (Sidecar / Target)

Rust acts as a **target** (child process). It is compiled to a binary placed in `.ghost-bridge/rust/<bridge_name>/target/release/`.

---

## Environment

| Concern | Rule |
|---------|------|
| Toolchain | `rustup`-managed, stable channel |
| Build | `cargo build --release` inside `.ghost-bridge/rust/<bridge_name>/` |
| Executable | `.ghost-bridge/rust/<bridge_name>/target/release/<bridge_name>` |
| JSON | `serde_json` crate (add to `Cargo.toml`) |

---

## Startup Contract

1. Write `{"ready":true}\n` to stdout and flush before entering the loop.
2. Use `BufWriter` wrapping stdout, and call `.flush()` after every write.

```rust
use std::io::{self, BufRead, Write};

fn main() {
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    // Ready signal
    writeln!(out, "{{\"ready\":true}}").unwrap();
    out.flush().unwrap();

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        // parse and handle
    }
}
```

---

## Shutdown / Signal Rules

```rust
use ctrlc;

ctrlc::set_handler(|| {
    std::process::exit(0);
}).expect("Error setting Ctrl-C handler");
```

- Add `ctrlc = "3"` to `Cargo.toml`.
- stdin EOF loop termination (`Err(_) => break`) covers the parent-died case automatically.

---

## stdout Discipline

- Always use `BufWriter` and call `flush()` after every response line.
- Never `println!` outside the JSON-RPC write path.

---

## Error Format

```rust
let err = serde_json::json!({
    "id": id,
    "error": { "message": e.to_string(), "traceback": format!("{:?}", e) }
});
writeln!(out, "{}", err).unwrap();
out.flush().unwrap();
```
