package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"

	goruby "github.com/claude-bridge/bridges/go-ruby"
)

func main() {
	// Resolve the sibling test-child.rb relative to this source file's directory
	// so the test client can be run from any working directory.
	_, thisFile, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(thisFile), "..", "test-child.rb")
	if _, err := os.Stat(script); err != nil {
		log.Fatalf("test-child.rb not found at %s: %v", script, err)
	}

	client, err := goruby.New(script)
	if err != nil {
		log.Fatalf("failed to start sidecar: %v", err)
	}
	defer client.Close()

	// ── echo ──────────────────────────────────────────────────────────────────
	var echoResult map[string]any
	if err := client.Call("echo", map[string]any{"text": "hello from Go"}, &echoResult); err != nil {
		log.Fatalf("echo error: %v", err)
	}
	fmt.Printf("echo result: %s\n", mustJSON(echoResult))

	// ── add ───────────────────────────────────────────────────────────────────
	var addResult map[string]any
	if err := client.Call("add", map[string]any{"a": 17, "b": 25}, &addResult); err != nil {
		log.Fatalf("add error: %v", err)
	}
	fmt.Printf("add result: %s\n", mustJSON(addResult))

	// ── raise_error ───────────────────────────────────────────────────────────
	err = client.Call("raise_error", map[string]any{"msg": "intentional failure"}, nil)
	if err != nil {
		fmt.Printf("raise_error (expected): %v\n", err)
	}

	// ── echo_b64 ──────────────────────────────────────────────────────────────
	var b64Result map[string]any
	if err := client.Call("echo_b64", map[string]any{"data": "SGVsbG8gV29ybGQ="}, &b64Result); err != nil {
		log.Fatalf("echo_b64 error: %v", err)
	}
	fmt.Printf("echo_b64 result: %s\n", mustJSON(b64Result))

	// ── slow ──────────────────────────────────────────────────────────────────
	var slowResult map[string]any
	if err := client.Call("slow", map[string]any{"ms": 100}, &slowResult); err != nil {
		log.Fatalf("slow error: %v", err)
	}
	fmt.Printf("slow result: %s\n", mustJSON(slowResult))

	fmt.Println("all manual smoke-tests passed")
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
