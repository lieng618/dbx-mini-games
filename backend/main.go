// Command dbx-board-games is the native sidecar for the DBX board-games plugin.
//
// It speaks the DBX plugin protocol on stdin/stdout and keeps every diagnostic on
// stderr, because stdout belongs to the protocol.
package main

import (
	"encoding/json"
	"log"
	"os"
	"sync"

	"github.com/southernMortals/dbx-board-games/backend/internal/app"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// handler adapts the DBX JSON-RPC surface onto the plugin app.
type handler struct {
	mu    sync.RWMutex
	app   *app.App
	emitter *dbxpluginsdk.Emitter
}

// Handle dispatches one host request. The host sends a bare method name with a JSON
// params object; any app error becomes a plugin error the host can surface.
func (h *handler) Handle(_ dbxpluginsdk.RequestContext, method string, params json.RawMessage, emitter *dbxpluginsdk.Emitter) (any, *dbxpluginsdk.PluginError) {
	h.mu.Lock()
	h.emitter = emitter
	h.mu.Unlock()

	decoded := map[string]any{}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &decoded); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "请求参数格式错误")
		}
	}

	result, err := h.app.Call(method, decoded)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, err.Error())
	}
	return result, nil
}

// emit publishes a plugin event to the host. The host ignores events sent before the
// first request, which is why the emitter is captured per request.
func (h *handler) emit(method string, params any) {
	h.mu.RLock()
	emitter := h.emitter
	h.mu.RUnlock()
	if emitter == nil {
		return
	}
	if err := emitter.Event(method, params); err != nil {
		log.Printf("event %s delivery failed: %s", method, err.Message)
	}
}

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	dataDir := os.Getenv("DBX_PLUGIN_DATA_DIR")
	if dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			log.Fatalf("cannot resolve a config directory: %v", err)
		}
		dataDir = base + string(os.PathSeparator) + "dbx-board-games"
	}

	// The app publishes events through the handler, which needs the app in turn; wiring
	// it in two steps keeps the dependency one-directional at construction time.
	h := &handler{}
	h.app = app.New(dataDir, h.emit)

	server := dbxpluginsdk.NewServer(dbxpluginsdk.Metadata{
		ID:           "io.github.southernmortals.board-games",
		Version:      version,
		Capabilities: []string{"events", "lan-game"},
	}, h)

	if err := server.Serve(); err != nil {
		log.Printf("DBX bridge stopped: %v", err)
	}
}

// version is stamped by the packaging script; the manifest remains the source of truth.
const version = "0.2.1"
