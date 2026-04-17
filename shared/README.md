# Stitch — Shared Modules

This directory contains extracted boilerplate that was previously duplicated across all 13 bridge-pair templates. Each module is the single source of truth for its language.

## Module overview

| Module | Language | Type | Provides |
|---|---|---|---|
| `typescript/bridge-client-base.ts` | TypeScript | client | `killChild`, `createPendingMap`, abstract `BridgeClientBase` (stdout parser, cleanup hooks, `call<T>`) |
| `typescript/path-helpers.ts` | TypeScript | client | `getVenvPython`, `getBinaryPath` |
| `go/bridge_client.go` | Go | client | `RpcResponse`, `RpcError`, `PendingMap` (Register/Dispatch/Delete/Drain), `NewScanner` (4 MiB), `KillChild`, `WaitReady` |
| `python/bridge_client.py` | Python | client | `BridgeClientBase` (spawn, reader thread, `_call`, `close`, `__enter__`/`__exit__`, signal handlers) |
| `rust/bridge_client.rs` | Rust | client | `RpcResponse`, `RpcError`, `PendingMap`, `spawn_reader_thread`, `kill_child`, `register_call` |
| `python_sidecar/sidecar_base.py` | Python | sidecar | `set_rpc_out`, `run_sidecar(handlers)` (watchdog, ready signal, main loop) |
| `ruby_sidecar/sidecar_base.rb` | Ruby | sidecar | sync setup, signal traps, watchdog thread, `send_response`, `run_sidecar(handlers)` |
| `go_sidecar/sidecar.go` | Go | sidecar | `NewWriter`, `NewScanner`, `SendReady`, `SendResponse`, `InstallSignalHandler`, `SidecarError` |
| `rust_sidecar/src/lib.rs` | Rust | sidecar | `send_ready`, `send_response`, `send_error`, `run_sidecar(dispatch_fn)` |

## Which bridge pairs use each module

### TypeScript client base (`typescript/bridge-client-base.ts`, `typescript/path-helpers.ts`)

| Bridge pair | Template file |
|---|---|
| typescript-python | `bridges/typescript-python/template.client.ts` |
| typescript-ruby | `bridges/typescript-ruby/template.client.ts` |
| typescript-rust | `bridges/typescript-rust/template.client.ts` |
| typescript-go | `bridges/typescript-go/template.client.ts` |

### Go client base (`go/bridge_client.go`)

| Bridge pair | Template file |
|---|---|
| go-python | `bridges/go-python/template.client.go` |
| go-ruby | `bridges/go-ruby/template.client.go` |
| go-nodejs | `bridges/go-nodejs/template.client.go` |

### Python client base (`python/bridge_client.py`)

| Bridge pair | Template file |
|---|---|
| python-ruby | `bridges/python-ruby/template.client.py` |
| python-rust | `bridges/python-rust/template.client.py` |
| python-go | `bridges/python-go/template.client.py` |

### Rust client base (`rust/bridge_client.rs`)

| Bridge pair | Template file |
|---|---|
| rust-python | `bridges/rust-python/template.client/src/main.rs` |
| rust-go | `bridges/rust-go/template.client/src/main.rs` |
| rust-ruby | `bridges/rust-ruby/template.client/src/main.rs` |

### Python sidecar base (`python_sidecar/sidecar_base.py`)

| Bridge pair | Template file |
|---|---|
| typescript-python | `bridges/typescript-python/template.sidecar.py` |
| go-python | `bridges/go-python/template.sidecar.py` |
| rust-python | `bridges/rust-python/template.sidecar.py` |

### Ruby sidecar base (`ruby_sidecar/sidecar_base.rb`)

| Bridge pair | Template file |
|---|---|
| typescript-ruby | `bridges/typescript-ruby/template.sidecar.rb` |
| go-ruby | `bridges/go-ruby/template.sidecar.rb` |
| python-ruby | `bridges/python-ruby/template.sidecar.rb` |
| rust-ruby | `bridges/rust-ruby/template.sidecar.rb` |

### Go sidecar base (`go_sidecar/sidecar.go`)

| Bridge pair | Template file |
|---|---|
| typescript-go | `bridges/typescript-go/template.sidecar/main.go` |
| python-go | `bridges/python-go/template.sidecar/main.go` |
| rust-go | `bridges/rust-go/template.sidecar/main.go` |

### Rust sidecar base (`rust_sidecar/src/lib.rs`)

| Bridge pair | Template file |
|---|---|
| typescript-rust | `bridges/typescript-rust/template.sidecar/src/main.rs` |
| python-rust | `bridges/python-rust/template.sidecar/src/main.rs` |

## Import patterns

### TypeScript templates
```typescript
import { BridgeClientBase, killChild } from '../../shared/typescript/bridge-client-base';
import { getVenvPython, getBinaryPath } from '../../shared/typescript/path-helpers';
```

### Go client templates
```go
import ghostbridge "github.com/stitch/shared/go"
```

### Python client templates
```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared', 'python'))
from bridge_client import BridgeClientBase, BridgeError
```

### Rust client templates
```rust
mod bridge_client;
use bridge_client::*;
```
(copy `shared/rust/bridge_client.rs` into the crate as `src/bridge_client.rs`)

### Python sidecar templates
```python
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared', 'python_sidecar'))
from sidecar_base import run_sidecar, set_rpc_out
set_rpc_out(_rpc_out)
run_sidecar(HANDLERS)
```

### Ruby sidecar templates
```ruby
require_relative '../../shared/ruby_sidecar/sidecar_base'
run_sidecar(HANDLERS)
```

### Go sidecar templates
```go
import sidecar "github.com/stitch/shared/go_sidecar"
```

### Rust sidecar templates
```toml
# Cargo.toml
[dependencies]
stitch_sidecar = { path = "../../shared/rust_sidecar" }
```
```rust
use stitch_sidecar::run_sidecar;
run_sidecar(|method, params| { ... });
```
