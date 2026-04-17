// Ghost-Bridge test-child Go sidecar.
//
// Implements a concrete set of JSON-RPC methods used by the integration tests:
//
//   echo        {"text":"<str>"}          → {"text":"<str>"}
//   add         {"a":<num>,"b":<num>}     → {"sum":<num>}
//   raise_error {"code":<int>,"message":<str>} → error response
//   echo_b64    {"data":"<base64>"}       → {"data":"<base64>"}
//   slow        {"ms":<int>}              → {"slept_ms":<int>}
//
// Protocol: newline-delimited JSON over stdio.
// First output line is always {"ready":true}.
// stdin EOF → clean exit.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// ── Wire types ────────────────────────────────────────────────────────────────

type ReadyMessage struct {
	Ready bool `json:"ready"`
}

type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type SuccessResponse struct {
	ID     string      `json:"id"`
	Result interface{} `json:"result"`
}

type ErrorObject struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type ErrorResponse struct {
	ID    string      `json:"id"`
	Error ErrorObject `json:"error"`
}

// ── Writer ────────────────────────────────────────────────────────────────────

var stdoutWriter = bufio.NewWriter(os.Stdout)

func writeJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[test-child] marshal error: %v\n", err)
		return
	}
	fmt.Fprintln(stdoutWriter, string(data))
	if err := stdoutWriter.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "[test-child] flush error: %v\n", err)
	}
}

func sendSuccess(id string, result interface{}) {
	writeJSON(SuccessResponse{ID: id, Result: result})
}

func sendError(id string, code int, message string) {
	writeJSON(ErrorResponse{
		ID:    id,
		Error: ErrorObject{Code: code, Message: message},
	})
}

// ── Method: echo ─────────────────────────────────────────────────────────────

type EchoParams struct {
	Text string `json:"text"`
}

func handleEcho(req *Request) {
	var p EchoParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		sendError(req.ID, -32602, fmt.Sprintf("invalid params: %v", err))
		return
	}
	sendSuccess(req.ID, map[string]interface{}{"text": p.Text})
}

// ── Method: add ──────────────────────────────────────────────────────────────

type AddParams struct {
	A float64 `json:"a"`
	B float64 `json:"b"`
}

func handleAdd(req *Request) {
	var p AddParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		sendError(req.ID, -32602, fmt.Sprintf("invalid params: %v", err))
		return
	}
	// Use integer arithmetic when both values are whole numbers.
	sum := p.A + p.B
	if p.A == float64(int64(p.A)) && p.B == float64(int64(p.B)) {
		sendSuccess(req.ID, map[string]interface{}{"sum": int64(sum)})
	} else {
		sendSuccess(req.ID, map[string]interface{}{"sum": sum})
	}
}

// ── Method: raise_error ───────────────────────────────────────────────────────

type RaiseErrorParams struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func handleRaiseError(req *Request) {
	var p RaiseErrorParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		sendError(req.ID, -32602, fmt.Sprintf("invalid params: %v", err))
		return
	}
	sendError(req.ID, p.Code, p.Message)
}

// ── Method: echo_b64 ─────────────────────────────────────────────────────────
// Accepts a base64-encoded string and echoes it back unchanged.
// This is used to test large payload handling / scanner buffer limits.

type EchoB64Params struct {
	Data string `json:"data"`
}

func handleEchoB64(req *Request) {
	var p EchoB64Params
	if err := json.Unmarshal(req.Params, &p); err != nil {
		sendError(req.ID, -32602, fmt.Sprintf("invalid params: %v", err))
		return
	}
	sendSuccess(req.ID, map[string]interface{}{"data": p.Data})
}

// ── Method: slow ─────────────────────────────────────────────────────────────
// Sleeps for the requested number of milliseconds then responds.

type SlowParams struct {
	Ms int `json:"ms"`
}

func handleSlow(req *Request) {
	var p SlowParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		sendError(req.ID, -32602, fmt.Sprintf("invalid params: %v", err))
		return
	}
	if p.Ms < 0 {
		sendError(req.ID, -32602, "ms must be non-negative")
		return
	}
	time.Sleep(time.Duration(p.Ms) * time.Millisecond)
	sendSuccess(req.ID, map[string]interface{}{"slept_ms": p.Ms})
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

func dispatch(req *Request) {
	switch req.Method {
	case "echo":
		handleEcho(req)
	case "add":
		handleAdd(req)
	case "raise_error":
		handleRaiseError(req)
	case "echo_b64":
		handleEchoB64(req)
	case "slow":
		handleSlow(req)
	default:
		sendError(req.ID, -32601, fmt.Sprintf("method not found: %s", req.Method))
	}
}

// ── Signal handling ───────────────────────────────────────────────────────────

func installSignalHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-ch
		fmt.Fprintf(os.Stderr, "[test-child] signal %v — exiting\n", sig)
		os.Exit(0)
	}()
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	installSignalHandler()

	// Announce readiness before reading anything.
	writeJSON(ReadyMessage{Ready: true})

	// Increase scanner buffer to 4 MB to handle large base64 payloads.
	// The default 64 KB limit would cause bufio.ErrTooLong for the 128 KB test.
	scanner := bufio.NewScanner(os.Stdin)
	const maxBuffer = 4 * 1024 * 1024 // 4 MB
	scanner.Buffer(make([]byte, maxBuffer), maxBuffer)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			fmt.Fprintf(os.Stderr, "[test-child] parse error: %v\n", err)
			continue
		}
		if req.ID == "" {
			fmt.Fprintf(os.Stderr, "[test-child] missing id, ignoring\n")
			continue
		}

		dispatch(&req)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "[test-child] scanner error: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "[test-child] stdin EOF — exiting cleanly")
	os.Exit(0)
}
