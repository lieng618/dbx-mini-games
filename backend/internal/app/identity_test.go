package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// TestSidecarIdentityMatchesManifest guards the contract DBX enforces at startup: the id
// and version the sidecar reports must equal the manifest's. A mismatch makes the host
// refuse to run the backend with "Sidecar identity or protocol does not match manifest",
// which is only visible at runtime.
func TestSidecarIdentityMatchesManifest(t *testing.T) {
	root := filepath.Join("..", "..", "..")

	raw, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Skipf("manifest not reachable from the test working directory: %v", err)
	}
	var manifest struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}

	source, err := os.ReadFile(filepath.Join(root, "backend", "main.go"))
	if err != nil {
		t.Fatalf("cannot read the sidecar entrypoint: %v", err)
	}

	idPattern := regexp.MustCompile(`ID:\s+"([^"]+)"`)
	versionPattern := regexp.MustCompile(`const version = "([^"]+)"`)

	idMatch := idPattern.FindSubmatch(source)
	if idMatch == nil {
		t.Fatal("the sidecar entrypoint must declare a plugin id")
	}
	if got := string(idMatch[1]); got != manifest.ID {
		t.Fatalf("sidecar id %q must equal manifest id %q", got, manifest.ID)
	}

	versionMatch := versionPattern.FindSubmatch(source)
	if versionMatch == nil {
		t.Fatal("the sidecar entrypoint must declare a version")
	}
	if got := string(versionMatch[1]); got != manifest.Version {
		t.Fatalf("sidecar version %q must equal manifest version %q", got, manifest.Version)
	}
}
