import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGameServerConfig } from "./game-server-config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDirectory = resolve(projectRoot, "ui");
const textExtensions = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);
const loopbackEndpointPattern =
  /(?:https?|wss?):\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/gi;

async function collectTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(path)));
    } else if (textExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}

const config = await loadGameServerConfig();
const files = await collectTextFiles(uiDirectory);
const loopbackLocations = [];

for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(loopbackEndpointPattern)) {
    loopbackLocations.push(`${relative(projectRoot, file)}: ${match[0]}`);
  }
}

const app = await readFile(resolve(uiDirectory, "app.js"), "utf8");
const failures = [];
if (loopbackLocations.length) {
  failures.push(`production UI contains local endpoints:\n${loopbackLocations.join("\n")}`);
}
if (!app.includes(config.websocketUrl)) {
  failures.push(`production UI does not contain the configured WebSocket URL ${config.websocketUrl}`);
}
if (!app.includes(config.publicOrigin)) {
  failures.push(`production UI does not contain the configured public origin ${config.publicOrigin}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        publicOrigin: config.publicOrigin,
        websocketUrl: config.websocketUrl,
        filesChecked: files.length,
        loopbackEndpoints: 0,
      },
      null,
      2,
    ),
  );
}
