// Ghost-Bridge Go sidecar template.
//
// Protocol (newline-delimited JSON over stdio):
//
//   Startup  : write {"ready":true} immediately after init
//   Request  : {"id":"<uuid>","method":"<name>","params":<any>}
//   Success  : {"id":"<uuid>","result":<any>}
//   Error    : {"id":"<uuid>","error":{"code":<int>,"message":"<str>"}}
//   Shutdown : stdin EOF → clean exit (os.Exit(0))
//
// Debug logs go to stderr only — never to stdout.

package main

import (
	"encoding/json"
	"fmt"
	"os"

	sidecar "github.com/ghost-bridge/shared/go_sidecar"
)

// ── Wire types ────────────────────────────────────────────────────────────────

// Request is a JSON-RPC request received from the Rust client.
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// ── Method dispatch ───────────────────────────────────────────────────────────

var out = sidecar.NewWriter()

// dispatch routes an incoming request to the correct handler.
// TODO: register your own methods here.
func dispatch(req *Request) {
	switch req.Method {
	// TODO: add your method implementations here.
	// Example:
	//   case "my_method":
	//       handleMyMethod(req)
	default:
		sidecar.SendResponse(out, req.ID, nil, &sidecar.SidecarError{
			Code:    -32601,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		})
	}
}

// ── Main loop ─────────────────────────────────────────────────────────────────

func main() {
	sidecar.InstallSignalHandler()
	sidecar.SendReady(out)

	scanner := sidecar.NewScanner()

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			fmt.Fprintf(os.Stderr, "[sidecar] parse error: %v — line: %s\n", err, line)
			continue
		}

		if req.ID == "" {
			fmt.Fprintf(os.Stderr, "[sidecar] request missing id, ignoring\n")
			continue
		}

		dispatch(&req)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "[sidecar] scanner error: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "[sidecar] stdin closed — exiting cleanly")
	os.Exit(0)
}
