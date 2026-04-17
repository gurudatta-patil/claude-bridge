# Language Rules — Go (Client / Source)

Go acts as a **source** (parent process), spawning a sidecar and communicating via JSON-RPC over stdio.

---

## Environment

| Concern | Rule |
|---------|------|
| Minimum version | Go 1.21 |
| JSON library | `encoding/json` (stdlib) |
| Process spawn | `os/exec.Cmd` with explicit `Stdin`, `Stdout`, `Stderr` pipes |

---

## Startup Contract

1. Set `cmd.Stdin`, `cmd.Stdout`, `cmd.Stderr` pipes before `cmd.Start()`.
2. Read lines from stdout via `bufio.Scanner` until `{"ready":true}` is received.
3. Then begin sending requests.

---

## Shutdown / Signal Rules

```go
import (
    "os"
    "os/signal"
    "syscall"
)

sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

go func() {
    <-sigCh
    cmd.Process.Signal(syscall.SIGTERM)
    // Give child 2 s to exit cleanly
    time.AfterFunc(2*time.Second, func() { cmd.Process.Kill() })
    os.Exit(0)
}()
```

- On parent exit, Go's runtime does NOT automatically kill child processes.
- The signal goroutine above is **mandatory** in every generated Go client.
- Also call `cmd.Process.Signal(syscall.SIGTERM)` in any `defer` cleanup.

---

## stdout Framing

```go
scanner := bufio.NewScanner(cmd.Stdout)
for scanner.Scan() {
    line := scanner.Text()
    // parse JSON-RPC response
}
```

---

## ID Strategy

Use an atomic counter (`sync/atomic`) cast to string for thread-safe concurrent calls.

---

## Type Generation

Generated Go client uses named structs for params and results.
```go
type ProcessImageParams struct { Path string `json:"path"` }
type ProcessImageResult struct { Base64 string `json:"base64"` }
```
