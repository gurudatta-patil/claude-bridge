// node_lookup.go — utility to locate the node executable on the current system.
package gobridge

import (
	"fmt"
	"os/exec"
	"runtime"
)

// LookupNode returns the path to the node executable, checking platform-specific
// names (node.exe on Windows) and falling back to PATH lookup.
func LookupNode() (string, error) {
	candidates := []string{"node"}
	if runtime.GOOS == "windows" {
		candidates = append([]string{"node.exe"}, candidates...)
	}
	for _, name := range candidates {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("node executable not found in PATH (tried: %v)", candidates)
}
