import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const projectRoot = resolve(scriptDirectory, "..");
export const gameServerConfigPath = resolve(projectRoot, "config/game-server.env");
export const manifestPath = resolve(projectRoot, "manifest.json");

function parseEnv(raw) {
  const values = {};
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid line in ${gameServerConfigPath}: ${sourceLine}`);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function requiredValue(values, key) {
  const value = values[key];
  if (!value) throw new Error(`${key} is required in ${gameServerConfigPath}`);
  return value;
}

function parseOrigin(raw, key, protocols) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute URL in ${gameServerConfigPath}`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${key} must use ${protocols.join(" or ")} in ${gameServerConfigPath}`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must be an origin without a path, query, or fragment`);
  }
  return parsed;
}

function webSocketUrl(origin, path) {
  const parsed = new URL(path, origin);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

export async function loadGameServerConfig() {
  const values = parseEnv(await readFile(gameServerConfigPath, "utf8"));
  const publicUrl = parseOrigin(
    requiredValue(values, "PUBLIC_ORIGIN"),
    "PUBLIC_ORIGIN",
    ["https:"],
  );
  const publicHost = requiredValue(values, "PUBLIC_HOST");
  if (publicHost !== publicUrl.hostname) {
    throw new Error("PUBLIC_HOST must match the hostname in PUBLIC_ORIGIN");
  }
  const localUrl = parseOrigin(
    requiredValue(values, "LOCAL_ORIGIN"),
    "LOCAL_ORIGIN",
    ["http:", "https:"],
  );
  const websocketPath = requiredValue(values, "WEBSOCKET_PATH");
  if (
    !websocketPath.startsWith("/") ||
    websocketPath.startsWith("//") ||
    /[?#]/.test(websocketPath)
  ) {
    throw new Error(
      `WEBSOCKET_PATH must be a path beginning with one slash in ${gameServerConfigPath}`,
    );
  }

  const manifestPermission = `host.network:${publicUrl.origin}`;
  if (!/^host\.network:https:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?$/.test(manifestPermission)) {
    throw new Error(
      "PUBLIC_ORIGIN must use a hostname or IPv4 address accepted by the DBX manifest schema",
    );
  }

  return Object.freeze({
    publicOrigin: publicUrl.origin,
    websocketPath,
    websocketUrl: webSocketUrl(publicUrl, websocketPath),
    localOrigin: localUrl.origin,
    localWebsocketUrl: webSocketUrl(localUrl, websocketPath),
    manifestPermission,
  });
}

export async function syncGameServerConfig() {
  const config = await loadGameServerConfig();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const nextPermissions = [];
  let replaced = false;

  for (const permission of permissions) {
    if (typeof permission !== "string" || !permission.startsWith("host.network:")) {
      nextPermissions.push(permission);
      continue;
    }
    if (!replaced) {
      nextPermissions.push(config.manifestPermission);
      replaced = true;
    }
  }
  if (!replaced) nextPermissions.push(config.manifestPermission);

  const nextManifest = { ...manifest, permissions: nextPermissions };
  const serialized = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const changed = serialized !== JSON.stringify(manifest, null, 2) + "\n";
  if (changed) await writeFile(manifestPath, serialized, "utf8");
  return { config, changed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { config, changed } = await syncGameServerConfig();
  console.log(
    `[game-server] ${config.publicOrigin}${config.websocketPath}` +
      (changed ? " (manifest updated)" : ""),
  );
}
