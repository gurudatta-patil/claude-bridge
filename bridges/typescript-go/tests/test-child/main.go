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
// Protocol types
// ---------------------------------------------------------------------------

type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type Response struct {
	ID     string      `json:"id"`
	Result interface{} `json:"result"`
}

type ErrorDetail struct {
	Message   string `json:"message"`
	Traceback string `json:"traceback"`
}

type ErrorResponse struct {
	ID    string      `json:"id"`
	Error ErrorDetail `json:"error"`
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

var stdout = bufio.NewWriter(os.Stdout)

func writeJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "writeJSON marshal error: %v\n", err)
		return
	}
	fmt.Fprintln(stdout, string(data))
	if err := stdout.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "writeJSON flush error: %v\n", err)
	}
}

func sendError(id string, err error) {
	writeJSON(ErrorResponse{
		ID: id,
		Error: ErrorDetail{
			Message:   err.Error(),
			Traceback: fmt.Sprintf("%+v", err),
		},
	})
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

// echo returns the received message unchanged.
func handleEcho(req Request) {
	var params struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendError(req.ID, fmt.Errorf("echo: invalid params: %w", err))
		return
	}
	writeJSON(Response{ID: req.ID, Result: map[string]string{"message": params.Message}})
}

// add returns the sum of two float64 numbers.
// Go decodes all JSON numbers as float64 by default.
func handleAdd(req Request) {
	var params struct {
		A float64 `json:"a"`
		B float64 `json:"b"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendError(req.ID, fmt.Errorf("add: invalid params: %w", err))
		return
	}
	writeJSON(Response{ID: req.ID, Result: map[string]float64{"sum": params.A + params.B}})
}

// raise_error always returns a JSON-RPC error response — used to test error bubbling.
func handleRaiseError(req Request) {
	var params struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendError(req.ID, fmt.Errorf("raise_error: invalid params: %w", err))
		return
	}
	msg := params.Message
	if msg == "" {
		msg = "deliberate test error"
	}
	sendError(req.ID, fmt.Errorf("%s", msg))
}

// echo_b64 base64-encodes the input string and returns it.
func handleEchoB64(req Request) {
	var params struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendError(req.ID, fmt.Errorf("echo_b64: invalid params: %w", err))
		return
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(params.Data))
	writeJSON(Response{ID: req.ID, Result: map[string]string{"encoded": encoded}})
}

// slow sleeps for the requested number of milliseconds, then echoes back.
func handleSlow(req Request) {
	var params struct {
		Ms      int    `json:"ms"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendError(req.ID, fmt.Errorf("slow: invalid params: %w", err))
		return
	}
	if params.Ms < 0 || params.Ms > 30_000 {
		sendError(req.ID, fmt.Errorf("slow: ms must be between 0 and 30000"))
		return
	}
	time.Sleep(time.Duration(params.Ms) * time.Millisecond)
	writeJSON(Response{ID: req.ID, Result: map[string]interface{}{
		"slept_ms": params.Ms,
		"message":  params.Message,
	}})
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

func dispatch(req Request) {
	fmt.Fprintf(os.Stderr, "dispatch: method=%s id=%s\n", req.Method, req.ID)
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
		sendError(req.ID, fmt.Errorf("unknown method: %s", req.Method))
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		fmt.Fprintf(os.Stderr, "received signal %v — shutting down\n", sig)
		os.Exit(0)
	}()

	// Announce readiness.
	writeJSON(map[string]bool{"ready": true})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 10*1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			fmt.Fprintf(os.Stderr, "failed to parse request: %v — raw: %s\n", err, line)
			continue
		}
		dispatch(req)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "scanner error: %v\n", err)
		os.Exit(1)
	}
}
