import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { loadGameServerConfig } from "./scripts/game-server-config.mjs";

/**
 * The plugin UI runs inside the DBX sandbox, whose CSP allows inline and blob scripts but
 * blocks external script files. Everything therefore has to land in one inline bundle:
 * no dynamic imports, no CSS link tags, no separate chunks.
 */
export default defineConfig(async ({ command }) => {
  const gameServer = await loadGameServerConfig();
  return {
    define: {
      __DBX_GAME_SERVER_URL__: JSON.stringify(
        command === "build" ? gameServer.websocketUrl : gameServer.localWebsocketUrl,
      ),
      __DBX_PUBLIC_ORIGIN__: JSON.stringify(
        command === "build" ? gameServer.publicOrigin : gameServer.localOrigin,
      ),
    },
    plugins: [
      vue(),
      {
        name: "dbx-build-signal",
        closeBundle() {
          console.log("DBX_UI_BUILD_SUCCESS");
        },
      },
    ],
    base: "./",
    build: {
      outDir: "ui",
      emptyOutDir: true,
      // Pixi's renderer choice is a dynamic import; that is exactly what the CSP forbids.
      // Forcing one chunk keeps every module on the inline path.
      modulePreload: false,
      cssCodeSplit: false,
      // Keep small assets as files: the sandbox serves the UI directory over HTTP, and
      // inlining everything into the HTML bloats the frame document.
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          entryFileNames: "app.js",
          chunkFileNames: "app.js",
          assetFileNames: "app.[ext]",
        },
      },
    },
  };
});
