// Package sidecar provides shared primitives for Stitch Go sidecars.
//
// All Go sidecars (typescript-go, python-go, rust-go) import this package
// instead of duplicating buffered writer, scanner, signal handler, and
// ready-signal boilerplate.
package sidecar

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// SidecarError is the JSON-RPC error object included in error responses.
type SidecarError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor helpers
// ─────────────────────────────────────────────────────────────────────────────

// NewWriter returns a bufio.Writer wrapping os.Stdout.
// All sidecar writes must go through this writer and be followed by Flush.
func NewWriter() *bufio.Writer {
	return bufio.NewWriter(os.Stdout)
}

// NewScanner returns a bufio.Scanner reading from os.Stdin with a 4 MiB
// buffer - large enough for substantial JSON payloads.
func NewScanner() *bufio.Scanner {
	scanner := bufio.NewScanner(os.Stdin)
	const maxBuf = 4 * 1024 * 1024
	scanner.Buffer(make([]byte, maxBuf), maxBuf)
	return scanner
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol helpers
// ─────────────────────────────────────────────────────────────────────────────

// SendReady writes the {"ready":true} handshake line and flushes.
// Call this once, before entering the request loop.
func SendReady(w *bufio.Writer) {
	writeJSON(w, map[string]bool{"ready": true})
}

// SendReadyWithMethods writes {"ready":true,"methods":[...]} and flushes.
// Prefer this over SendReady when the full method list is available.
func SendReadyWithMethods(w *bufio.Writer, methods []string) {
	writeJSON(w, map[string]interface{}{"ready": true, "methods": methods})
}

// SendResponse writes a JSON-RPC response to w and flushes.
// Pass a non-nil rpcErr to send an error response; otherwise result is used.
func SendResponse(w *bufio.Writer, id string, result interface{}, rpcErr *SidecarError) {
	type successResp struct {
		ID     string      `json:"id"`
		Result interface{} `json:"result"`
	}
	type errorResp struct {
		ID    string       `json:"id"`
		Error SidecarError `json:"error"`
	}

	if rpcErr != nil {
		writeJSON(w, errorResp{ID: id, Error: *rpcErr})
	} else {
		writeJSON(w, successResp{ID: id, Result: result})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal handler
// ─────────────────────────────────────────────────────────────────────────────

// InstallSignalHandler registers a goroutine that listens for SIGINT/SIGTERM
// and calls os.Exit(0) on receipt.  Call once from main().
func InstallSignalHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-ch
		fmt.Fprintf(os.Stderr, "[sidecar] received signal %v - exiting cleanly\n", sig)
		os.Exit(0)
	}()
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level convenience runner
// ─────────────────────────────────────────────────────────────────────────────

// RunSidecar runs the complete JSON-RPC sidecar loop with built-in handlers.
//
// It installs the signal handler, emits a ready signal that includes all
// method names (user-supplied + built-ins), then dispatches each incoming
// request to the appropriate handler function.
//
// Built-in methods added automatically:
//   - __ping__  →  {"pong":true,"pid":<pid>}
//
// The function returns when stdin reaches EOF; callers should not call
// os.Exit themselves - RunSidecar calls os.Exit(0) on clean shutdown.
func RunSidecar(handlers map[string]func(params map[string]interface{}) (interface{}, error)) {
	InstallSignalHandler()

	debug := os.Getenv("STITCH_DEBUG") == "1"

	// Register built-in handlers (user handlers take precedence).
	all := map[string]func(map[string]interface{}) (interface{}, error){
		"__ping__": func(_ map[string]interface{}) (interface{}, error) {
			return map[string]interface{}{"pong": true, "pid": os.Getpid()}, nil
		},
	}
	for k, v := range handlers {
		all[k] = v
	}

	// Collect sorted method names for the ready signal.
	methods := make([]string, 0, len(all))
	for k := range all {
		methods = append(methods, k)
	}

	w := NewWriter()
	SendReadyWithMethods(w, methods)

	scanner := NewScanner()
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var req map[string]interface{}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			writeJSON(w, map[string]interface{}{
				"id":    nil,
				"error": SidecarError{Code: -32700, Message: fmt.Sprintf("JSON parse error: %v", err)},
			})
			continue
		}

		id, _ := req["id"].(string)
		method, _ := req["method"].(string)
		params, _ := req["params"].(map[string]interface{})
		if params == nil {
			params = map[string]interface{}{}
		}

		if debug {
			logEntry := map[string]interface{}{"dir": "→", "id": id, "method": method}
			if tp, _ := req["traceparent"].(string); tp != "" {
				logEntry["traceparent"] = tp
			}
			debugLog(logEntry)
		}

		handler, ok := all[method]
		if !ok {
			SendResponse(w, id, nil, &SidecarError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", method)})
			if debug {
				debugLog(map[string]interface{}{"dir": "←", "id": id, "ok": false})
			}
			continue
		}

		result, err := handler(params)
		if err != nil {
			SendResponse(w, id, nil, &SidecarError{Code: -32000, Message: err.Error()})
			if debug {
				logEntry := map[string]interface{}{"dir": "←", "id": id, "ok": false}
				if tp, _ := req["traceparent"].(string); tp != "" {
					logEntry["traceparent"] = tp
				}
				debugLog(logEntry)
			}
		} else {
			SendResponse(w, id, result, nil)
			if debug {
				logEntry := map[string]interface{}{"dir": "←", "id": id, "ok": true}
				if tp, _ := req["traceparent"].(string); tp != "" {
					logEntry["traceparent"] = tp
				}
				debugLog(logEntry)
			}
		}
	}

	fmt.Fprintln(os.Stderr, "[sidecar] stdin closed, exiting")
	os.Exit(0)
}

// StreamingHandler is a handler that returns a channel of values for streaming
// responses.  Each value is sent as a chunk frame; the channel being closed
// terminates the stream.
type StreamingHandler func(params map[string]interface{}) (<-chan interface{}, error)

// SendChunk writes a streaming chunk frame {"id":"...","chunk":...} to w and
// flushes.  Call this for each item in a streaming response, then call
// SendResponse with an empty result map to signal end-of-stream.
func SendChunk(w *bufio.Writer, id string, chunk interface{}) {
	type chunkFrame struct {
		ID    string      `json:"id"`
		Chunk interface{} `json:"chunk"`
	}
	writeJSON(w, chunkFrame{ID: id, Chunk: chunk})
}

// addBuiltins merges the built-in __ping__ handler into the provided map and
// returns the combined map.  User handlers take precedence.
func addBuiltins(handlers map[string]func(map[string]interface{}) (interface{}, error)) map[string]func(map[string]interface{}) (interface{}, error) {
	all := map[string]func(map[string]interface{}) (interface{}, error){
		"__ping__": func(_ map[string]interface{}) (interface{}, error) {
			return map[string]interface{}{"pong": true, "pid": os.Getpid()}, nil
		},
	}
	for k, v := range handlers {
		all[k] = v
	}
	return all
}

// methodNames returns the keys of the provided handler map as a slice.
func methodNames(handlers map[string]func(map[string]interface{}) (interface{}, error)) []string {
	methods := make([]string, 0, len(handlers))
	for k := range handlers {
		methods = append(methods, k)
	}
	return methods
}

// RunConcurrentSidecar is like RunSidecar but dispatches each request in its
// own goroutine.  A mutex protects the shared writer so concurrent responses
// are serialised on stdout without interleaving.
func RunConcurrentSidecar(handlers map[string]func(map[string]interface{}) (interface{}, error)) {
	InstallSignalHandler()

	debug := os.Getenv("STITCH_DEBUG") == "1"

	allHandlers := addBuiltins(handlers)
	methods := methodNames(allHandlers)

	w := NewWriter()
	SendReadyWithMethods(w, methods)

	var wMu sync.Mutex

	scanner := NewScanner()
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		go func(l string) {
			var req map[string]interface{}
			if err := json.Unmarshal([]byte(l), &req); err != nil {
				wMu.Lock()
				writeJSON(w, map[string]interface{}{
					"id":    nil,
					"error": SidecarError{Code: -32700, Message: fmt.Sprintf("JSON parse error: %v", err)},
				})
				wMu.Unlock()
				return
			}

			id, _ := req["id"].(string)
			method, _ := req["method"].(string)
			params, _ := req["params"].(map[string]interface{})
			if params == nil {
				params = map[string]interface{}{}
			}
			tp, _ := req["traceparent"].(string)

			if debug {
				logEntry := map[string]interface{}{"dir": "→", "id": id, "method": method}
				if tp != "" {
					logEntry["traceparent"] = tp
				}
				debugLog(logEntry)
			}

			handler, ok := allHandlers[method]
			if !ok {
				wMu.Lock()
				SendResponse(w, id, nil, &SidecarError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", method)})
				wMu.Unlock()
				if debug {
					logEntry := map[string]interface{}{"dir": "←", "id": id, "ok": false}
					if tp != "" {
						logEntry["traceparent"] = tp
					}
					debugLog(logEntry)
				}
				return
			}

			result, err := handler(params)
			wMu.Lock()
			if err != nil {
				SendResponse(w, id, nil, &SidecarError{Code: -32000, Message: err.Error()})
			} else {
				SendResponse(w, id, result, nil)
			}
			wMu.Unlock()

			if debug {
				logEntry := map[string]interface{}{"dir": "←", "id": id, "ok": err == nil}
				if tp != "" {
					logEntry["traceparent"] = tp
				}
				debugLog(logEntry)
			}
		}(line)
	}

	fmt.Fprintln(os.Stderr, "[sidecar] stdin closed, exiting")
	os.Exit(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

func writeJSON(w *bufio.Writer, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[sidecar] marshal error: %v\n", err)
		return
	}
	w.Write(data)
	w.WriteByte('\n')
	if err := w.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "[sidecar] flush error: %v\n", err)
	}
}

func debugLog(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintf(os.Stderr, "%s\n", data)
}
