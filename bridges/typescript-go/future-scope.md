# Future Scope — TypeScript → Go Bridge

## 1. Goroutine pool for concurrent method handlers

The current sidecar dispatches methods synchronously in the scanner loop,
which means a slow handler blocks all subsequent requests.  A future version
could dispatch each request into a goroutine pool:

```go
sem := make(chan struct{}, 16) // max 16 concurrent handlers
for scanner.Scan() {
    req := parseRequest(scanner.Bytes())
    sem <- struct{}{}
    go func(r Request) {
        defer func() { <-sem }()
        dispatch(r)
    }(req)
}
```

Response ordering would become non-deterministic (as with the Python bridge),
which is fine because every response carries its own `id`.

---

## 2. gRPC-over-stdio using protobuf framing

Replace newline-delimited JSON with length-prefixed protobuf frames for
significantly higher throughput and strong schema enforcement.  The framing
protocol would be:

```
[4-byte big-endian length][protobuf payload]
```

On the TypeScript side, use `@grpc/proto-loader` and a custom stdio transport.
On the Go side, use `google.golang.org/protobuf`.  This approach eliminates
JSON parsing overhead for high-volume IPC.

---

## 3. Type sharing: Go structs → TypeScript via go-ts-types

Manually keeping Go structs and TypeScript interfaces in sync is error-prone.
Tools like `go-ts-types` or `tygo` can auto-generate TypeScript interfaces from
Go struct definitions:

```sh
tygo --package ./sidecar --output ../client/types.ts
```

This creates a single source of truth (the Go structs) and ensures the TS
client always has accurate types for request params and response shapes.

---

## 4. Hot reload via plugin system or RPC reload method

For development workflows, it would be useful to reload the Go handler logic
without restarting the parent process.  Two approaches:

- **RPC reload method**: the sidecar accepts a `{"method":"_reload"}` message,
  re-reads config or dynamic data from disk, and responds when ready.
- **Go plugin system**: compile handler modules as `*.so` shared libraries
  (`go build -buildmode=plugin`) and load them at runtime with
  `plugin.Open()`.  Limitations apply (same Go version, Linux/macOS only).

---

## 5. Shared memory via mmap for large data transfers

Passing large binary blobs (images, tensors) over stdio adds serialisation
overhead even with base64 encoding.  A future optimisation is to use
memory-mapped files:

1. TypeScript writes data to a temp file and passes the path in the RPC params.
2. Go maps the file with `syscall.Mmap` / `golang.org/x/sys/unix`.
3. Go processes the data in-place and returns only metadata (dimensions, hash,
   etc.) over stdio.
4. TypeScript reads the result file if the output is also large.

This keeps the stdio channel narrow and avoids unnecessary copying for
payloads in the MB–GB range.
