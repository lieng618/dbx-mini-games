import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncGameServerConfig } from "./game-server-config.mjs";

// DBX's Windows development host canonicalizes the project path to `\\?\D:\...`. npm.cmd
// and Vite 7 reject that verbatim form, so normalize the working directory before Vite
// loads its config and dependency graph.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { config, changed } = await syncGameServerConfig();
console.log(
  `[game-server] ${config.publicOrigin}${config.websocketPath}` +
    (changed ? " (manifest updated)" : ""),
);
process.chdir(projectRoot);

await import(pathToFileURL(resolve(projectRoot, "node_modules/vite/bin/vite.js")).href);
