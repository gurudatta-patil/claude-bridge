// Package main is the entry point for a Stitch Go sidecar.
//
// Protocol
// --------
//   - Newline-delimited JSON over stdio (stdin → requests, stdout → responses)
//   - On startup, write {"ready":true}\n to stdout BEFORE reading any requests
//   - Request:  {"id":"<uuid>","method":"<name>","params":<any>}
//   - Success:  {"id":"<uuid>","result":<any>}
//   - Error:    {"id":"<uuid>","error":{"code":<int>,"message":"<str>"}}
//   - bufio.Scanner on stdin; Scan() returns false on EOF → exit cleanly
//
// TODO: Replace the stub handler map with your real method implementations.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	sidecar "github.com/stitch/shared/go_sidecar"
)

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

// Request is an inbound JSON-RPC call from the Python client.
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

// HandlerFunc is the signature every method handler must satisfy.
type HandlerFunc func(params json.RawMessage) (interface{}, *sidecar.SidecarError)

// handlers maps method names to their implementations.
// TODO: Register your own methods here.
var handlers = map[string]HandlerFunc{
	// -----------------------------------------------------------------------
	// TODO: add your method handlers below, for example:
	//
	//   "my_method": handleMyMethod,
	// -----------------------------------------------------------------------
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

var out = sidecar.NewWriter()

func dispatch(req Request) {
	handler, ok := handlers[req.Method]
	if !ok {
		sidecar.SendResponse(out, req.ID, nil, &sidecar.SidecarError{
			Code:    -32601,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		})
		return
	}

	result, rpcErr := handler(req.Params)
	sidecar.SendResponse(out, req.ID, result, rpcErr)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	sidecar.InstallSignalHandler()
	sidecar.SendReady(out)

	scanner := sidecar.NewScanner()

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			sidecar.SendResponse(out, "", nil, &sidecar.SidecarError{
				Code:    -32700,
				Message: fmt.Sprintf("parse error: %v", err),
			})
			continue
		}

		dispatch(req)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stitch: stdin scanner error: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "stitch: stdin closed, exiting")
}
