// Command dbx-mini-games-server is the public, anonymous cloud service for the DBX Mini
// Games workbench. It is deliberately separate from DBX: the plugin is a frontend-only
// package and every browser connects here over WebSocket.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/cloud"
)

const version = "0.3.0"

func main() {
	addr := flag.String("addr", envOr("DBX_MINI_GAMES_ADDR", ":8787"), "HTTP listen address")
	uiDirectory := flag.String("ui", envOr("DBX_MINI_GAMES_UI", ""), "optional directory containing the built UI")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	hub := cloud.NewHub()
	server := &http.Server{
		Addr:              strings.TrimSpace(*addr),
		Handler:           cloud.NewServer(hub, logger, strings.TrimSpace(*uiDirectory)).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       75 * time.Second,
	}

	shutdownContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		<-shutdownContext.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			logger.Warn("server shutdown failed", "error", err)
		}
	}()

	logger.Info("DBX Mini Games cloud server ready", "version", version, "addr", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
