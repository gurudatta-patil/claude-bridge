// main.go — manual smoke-test client for the Go→Node.js bridge.
// Run:  go run . ../../tests/test-child.js
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"

	gobridge "github.com/stitch/go-nodejs"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatalf("usage: test-client <path/to/sidecar.js>")
	}
	script := os.Args[1]

	bridge, err := gobridge.NewNodeBridge(script)
	if err != nil {
		log.Fatalf("NewNodeBridge: %v", err)
	}
	defer bridge.Close()

	// --- echo ---
	res, err := bridge.Call("echo", map[string]any{"hello": "world"})
	if err != nil {
		log.Fatalf("echo: %v", err)
	}
	fmt.Printf("echo result: %s\n", res)

	// --- add ---
	res, err = bridge.Call("add", map[string]any{"a": 3, "b": 4})
	if err != nil {
		log.Fatalf("add: %v", err)
	}
	var addResult struct {
		Sum float64 `json:"sum"`
	}
	_ = json.Unmarshal(res, &addResult)
	fmt.Printf("add result: sum=%v\n", addResult.Sum)

	// --- raise_error ---
	_, err = bridge.Call("raise_error", map[string]any{"msg": "intentional"})
	if err != nil {
		fmt.Printf("raise_error (expected): %v\n", err)
	}

	// --- echo_b64 ---
	res, err = bridge.Call("echo_b64", map[string]any{"data": "SGVsbG8gV29ybGQ="})
	if err != nil {
		log.Fatalf("echo_b64: %v", err)
	}
	fmt.Printf("echo_b64 result: %s\n", res)

	// --- slow (concurrent) ---
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			r, e := bridge.Call("slow", map[string]any{"ms": 50, "tag": n})
			if e != nil {
				log.Printf("slow[%d]: %v", n, e)
				return
			}
			fmt.Printf("slow[%d] result: %s\n", n, r)
		}(i)
	}
	wg.Wait()

	fmt.Println("all tests passed")
}
