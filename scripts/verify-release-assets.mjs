import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "manifest.json"), "utf8"));
const target = "universal";
const packageName = `${manifest.id}-${manifest.version}-${target}.dbxp`;
const packagePath = resolve(projectRoot, "dist", packageName);
const releaseCandidates = JSON.parse(
  await readFile(resolve(projectRoot, "dist", "release-candidates.json"), "utf8"),
);
const storeCandidate = JSON.parse(
  await readFile(resolve(projectRoot, "store-submission", "candidates", `${manifest.id}.json`), "utf8"),
);
const bytes = await readFile(packagePath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const entries = execFileSync("tar", ["-tf", packagePath], { encoding: "utf8" }).split(/\r?\n/);
const packagedManifest = JSON.parse(execFileSync("tar", ["-xOf", packagePath, "manifest.json"], { encoding: "utf8" }));
const releaseArtifact = releaseCandidates.artifacts?.find((artifact) => artifact.target === target);

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(!entries.includes("signature.json"), "candidate contains signature.json");
check(releaseArtifact?.signingKeyId === undefined, "release candidate declares signingKeyId");
check(Boolean(releaseArtifact), "release-candidates has no universal artifact");
check(releaseArtifact?.sha256.toLowerCase() === sha256, "release-candidate SHA-256 does not match package bytes");
check(releaseArtifact?.size === bytes.length, "release-candidate size does not match package bytes");
check(packagedManifest.id === manifest.id, "packaged Manifest ID differs from source Manifest");
check(packagedManifest.version === manifest.version, "packaged Manifest version differs from source Manifest");
check(packagedManifest.publisher === manifest.publisher, "packaged Manifest publisher differs from source Manifest");
check(
  JSON.stringify([...packagedManifest.permissions].sort()) ===
    JSON.stringify([...manifest.permissions].sort()),
  "packaged Manifest permissions differ from source Manifest",
);
check(releaseCandidates.plugin?.id === manifest.id, "release-candidates plugin ID is wrong");
check(releaseCandidates.plugin?.version === manifest.version, "release-candidates version is wrong");
check(releaseCandidates.artifacts?.length === 1, "release-candidates must contain one universal artifact");
check(releaseCandidates.artifacts?.[0]?.sha256 === sha256, "release-candidates SHA-256 is wrong");
check(releaseCandidates.artifacts?.[0]?.size === bytes.length, "release-candidates size is wrong");
check(storeCandidate.id === manifest.id, "store candidate plugin ID is wrong");
check(storeCandidate.version === manifest.version, "store candidate version is wrong");
check(storeCandidate.publisher === manifest.publisher, "store candidate publisher is wrong");
check(storeCandidate.targets?.length === 1, "store candidate must contain one target");
check(storeCandidate.targets?.[0]?.target === target, "store candidate target is not universal");
check(storeCandidate.targets?.[0]?.sha256 === sha256, "store candidate SHA-256 is wrong");
check(storeCandidate.targets?.[0]?.size === bytes.length, "store candidate size is wrong");

if (process.argv.includes("--check-urls")) {
  for (const item of releaseCandidates.artifacts) {
    const url = item.url.startsWith("https://")
      ? item.url
      : `https://github.com/lieng618/dbx-mini-games/releases/download/v${manifest.version}/${item.url}`;
    const response = await fetch(url, { redirect: "follow" });
    check(response.ok, `release URL is not reachable: ${url}`);
    if (response.ok) {
      const remote = Buffer.from(await response.arrayBuffer());
      const remoteSha256 = createHash("sha256").update(remote).digest("hex");
      check(remoteSha256 === item.sha256, `remote package SHA-256 is wrong: ${url}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        package: packageName,
        sha256,
        size: bytes.length,
        unsigned: true,
        urlsChecked: process.argv.includes("--check-urls"),
      },
      null,
      2,
    ),
  );
}
