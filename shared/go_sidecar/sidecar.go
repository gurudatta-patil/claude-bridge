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
// buffer — large enough for substantial JSON payloads.
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
		fmt.Fprintf(os.Stderr, "[sidecar] received signal %v — exiting cleanly\n", sig)
		os.Exit(0)
	}()
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper
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
