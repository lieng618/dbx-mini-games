import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "manifest.json"), "utf8"));
const storeMetadata = JSON.parse(await readFile(resolve(projectRoot, ".dbx-store.json"), "utf8"));
const tag = process.argv[2] || `v${manifest.version}`;
const target = "universal";
const packageName = `${manifest.id}-${manifest.version}-${target}.dbxp`;
const metadataName = `${manifest.id}-${manifest.version}-${target}.artifact.json`;
const distDirectory = resolve(projectRoot, "dist");
const packagePath = resolve(distDirectory, packageName);
let metadata;
let metadataFromRelease = false;
try {
  const published = JSON.parse(await readFile(resolve(distDirectory, "release-candidates.json"), "utf8"));
  metadata = published.artifacts?.find(
    (artifact) =>
      artifact.target === target &&
      artifact.url &&
      (artifact.url === packageName || artifact.url.endsWith(`/${packageName}`)),
  );
  metadataFromRelease = Boolean(metadata);
} catch {
  // Local package builds before the first Release only have artifact metadata.
}
metadata ||= JSON.parse(await readFile(resolve(distDirectory, metadataName), "utf8"));
const packageBytes = await readFile(packagePath);
const sha256 = createHash("sha256").update(packageBytes).digest("hex");

if (metadata.target !== target || metadata.signingKeyId !== undefined) {
  throw new Error("The candidate artifact metadata is not an unsigned universal package");
}
if (metadata.sha256.toLowerCase() !== sha256 || metadata.size !== packageBytes.length) {
  throw new Error("The candidate artifact metadata does not match the package bytes");
}

const releaseBase = `https://github.com/lieng618/dbx-mini-games/releases/download/${tag}`;
const localizations = Object.fromEntries(
  Object.entries(manifest.localizations || {})
    .filter(([, value]) => value && typeof value === "object")
    .map(([locale, value]) => [
      locale,
      Object.fromEntries(
        ["name", "description"]
          .filter((key) => typeof value[key] === "string" && value[key].trim())
          .map((key) => [key, value[key]]),
      ),
    ]),
);
const candidate = {
  schemaVersion: 1,
  id: manifest.id,
  publisher: manifest.publisher,
  version: manifest.version,
  name: manifest.name,
  description: manifest.description,
  icon: `https://raw.githubusercontent.com/lieng618/dbx-mini-games/${tag}/${manifest.icon}`,
  tags: ["game", "chess", "gomoku", "multiplayer", "workbench"],
  permissions: manifest.permissions,
  source: `https://github.com/lieng618/dbx-mini-games/tree/${tag}`,
  homepage: manifest.homepage,
  license: "Apache-2.0",
  releaseNotes: storeMetadata.releaseNotes,
  localizations,
  targets: [
    {
      target,
      url: `${releaseBase}/${packageName}`,
      sha256,
      size: packageBytes.length,
    },
  ],
};

const submissionRoot = resolve(projectRoot, "store-submission");
await mkdir(resolve(submissionRoot, "publishers"), { recursive: true });
await mkdir(resolve(submissionRoot, "candidates"), { recursive: true });
await writeFile(
  resolve(submissionRoot, "publishers", `${manifest.publisher}.json`),
  `${JSON.stringify(
    {
      id: manifest.publisher,
      name: manifest.publisher,
      status: "unverified",
    },
    null,
    2,
  )}\n`,
);
const candidatePath = resolve(submissionRoot, "candidates", `${manifest.id}.json`);
await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
if (!metadataFromRelease) {
  await writeFile(
    resolve(distDirectory, "release-candidates.json"),
    `${JSON.stringify(
      {
        plugin: {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          publisher: manifest.publisher,
          version: manifest.version,
          permissions: [...manifest.permissions].sort(),
        },
        artifacts: [
          {
            target,
            url: `${releaseBase}/${packageName}`,
            sha256,
            size: packageBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      candidate: candidatePath,
      package: packagePath,
      url: candidate.targets[0].url,
      sha256,
      size: packageBytes.length,
    },
    null,
    2,
  ),
);
