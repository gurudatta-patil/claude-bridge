package main

import (
	"encoding/json"
	"fmt"
	"os"

	sidecar "github.com/ghost-bridge/shared/go_sidecar"
)

// Request represents an incoming JSON-RPC request from the parent process.
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// dispatch routes an incoming request to the appropriate handler.
// TODO: add your method handlers inside the switch statement below.
func dispatch(req Request) {
	switch req.Method {
	// TODO: implement your methods here, for example:
	//
	// case "your_method":
	//     var params struct {
	//         Field string `json:"field"`
	//     }
	//     if err := json.Unmarshal(req.Params, &params); err != nil {
	//         sidecar.SendResponse(out, req.ID, nil, &sidecar.SidecarError{Code: -32602, Message: err.Error()})
	//         return
	//     }
	//     sidecar.SendResponse(out, req.ID, map[string]interface{}{"field": params.Field}, nil)

	default:
		sidecar.SendResponse(out, req.ID, nil, &sidecar.SidecarError{
			Code:    -32601,
			Message: fmt.Sprintf("unknown method: %s", req.Method),
		})
	}
}

var out = sidecar.NewWriter()

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
			fmt.Fprintf(os.Stderr, "failed to parse request: %v\n", err)
			continue
		}

		dispatch(req)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "scanner error: %v\n", err)
		os.Exit(1)
	}
}
