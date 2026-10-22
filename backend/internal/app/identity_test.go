package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// TestFrontendManifestAndServerVersion guards the split between the frontend-only plugin
// package and the separately deployed cloud service. The plugin must not declare a
// backend entrypoint, and the server's advertised version must match the package.
func TestFrontendManifestAndServerVersion(t *testing.T) {
	root := filepath.Join("..", "..", "..")

	raw, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Skipf("manifest not reachable from the test working directory: %v", err)
	}
	var manifest struct {
		ID          string `json:"id"`
		Version     string `json:"version"`
		Entrypoints struct {
			Backend json.RawMessage `json:"backend"`
		} `json:"entrypoints"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}

	if len(manifest.Entrypoints.Backend) > 0 && string(manifest.Entrypoints.Backend) != "null" {
		t.Fatal("a frontend-only plugin must not declare a backend entrypoint")
	}

	source, err := os.ReadFile(filepath.Join(root, "backend", "main.go"))
	if err != nil {
		t.Fatalf("cannot read the sidecar entrypoint: %v", err)
	}

	versionPattern := regexp.MustCompile(`const version = "([^"]+)"`)

	versionMatch := versionPattern.FindSubmatch(source)
	if versionMatch == nil {
		t.Fatal("the cloud entrypoint must declare a version")
	}
	if got := string(versionMatch[1]); got != manifest.Version {
		t.Fatalf("server version %q must equal manifest version %q", got, manifest.Version)
	}
}
