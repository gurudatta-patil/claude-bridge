// Package main is the Go test-child sidecar used by the Python test suite.
//
// Implemented methods
// -------------------
//   echo       {"message": "<str>"}         → "<str>"
//   add        {"a": <num>, "b": <num>}     → <num>
//   raise_error{"message": "<str>"}         → error(code=42, message=<str>)
//   echo_b64   {"data": "<base64>"}         → "<base64>"  (round-trip)
//   slow       {"seconds": <num>}           → "done"  (after time.Sleep)
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type Response struct {
	ID     string      `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  *RPCError   `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ---------------------------------------------------------------------------
// Shared stdout writer
// ---------------------------------------------------------------------------

var stdout = bufio.NewWriter(os.Stdout)

func writeJSON(v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "test-child: marshal error: %v\n", err)
		return
	}
	stdout.Write(b)
	stdout.WriteByte('\n')
	stdout.Flush()
}

func errResp(id string, code int, msg string) Response {
	return Response{ID: id, Error: &RPCError{Code: code, Message: msg}}
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

// echo returns the "message" field unchanged.
func handleEcho(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("invalid params: %v", err)}
	}
	return p.Message, nil
}

// add returns the sum of two numbers.
// json.Number is used so that integer values are not mangled by float64 rounding.
func handleAdd(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		A json.Number `json:"a"`
		B json.Number `json:"b"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("invalid params: %v", err)}
	}
	a, err := p.A.Float64()
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("bad value for 'a': %v", err)}
	}
	b, err := p.B.Float64()
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("bad value for 'b': %v", err)}
	}
	sum := a + b
	// Return as integer if both inputs were whole numbers.
	if sum == float64(int64(sum)) {
		return int64(sum), nil
	}
	return sum, nil
}

// raiseError always returns a JSON-RPC error with code 42.
func handleRaiseError(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		p.Message = "unknown error"
	}
	return nil, &RPCError{Code: 42, Message: p.Message}
}

// echoB64 decodes the base64 "data" field and re-encodes it (round-trip check).
func handleEchoB64(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("invalid params: %v", err)}
	}
	raw, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("base64 decode error: %v", err)}
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// slow sleeps for the requested number of seconds then returns "done".
func handleSlow(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		Seconds json.Number `json:"seconds"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: fmt.Sprintf("invalid params: %v", err)}
	}
	secs, err := p.Seconds.Float64()
	if err != nil || secs < 0 {
		return nil, &RPCError{Code: -32602, Message: "seconds must be a non-negative number"}
	}
	time.Sleep(time.Duration(secs * float64(time.Second)))
	return "done", nil
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type HandlerFunc func(json.RawMessage) (interface{}, *RPCError)

var handlers = map[string]HandlerFunc{
	"echo":        handleEcho,
	"add":         handleAdd,
	"raise_error": handleRaiseError,
	"echo_b64":    handleEchoB64,
	"slow":        handleSlow,
}

func dispatch(req Request) Response {
	h, ok := handlers[req.Method]
	if !ok {
		return errResp(req.ID, -32601, fmt.Sprintf("method not found: %s", req.Method))
	}
	result, rpcErr := h(req.Params)
	if rpcErr != nil {
		return Response{ID: req.ID, Error: rpcErr}
	}
	return Response{ID: req.ID, Result: result}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	// Signal handling
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		fmt.Fprintf(os.Stderr, "test-child: received signal %v, exiting\n", sig)
		os.Exit(0)
	}()

	// Ready handshake — MUST be first output line
	writeJSON(map[string]bool{"ready": true})

	// Increase scanner buffer to 4 MiB to handle large payloads
	scanner := bufio.NewScanner(os.Stdin)
	buf := make([]byte, 4*1024*1024)
	scanner.Buffer(buf, cap(buf))

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			writeJSON(errResp("", -32700, fmt.Sprintf("parse error: %v", err)))
			continue
		}

		writeJSON(dispatch(req))
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "test-child: scanner error: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "test-child: stdin closed, exiting cleanly")
}
