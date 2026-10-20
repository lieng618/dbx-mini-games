#!/usr/bin/env bash
#
# Signs a packaged .dbxp with the repository key.
#
# The private key and the packager used to live only in /tmp and were lost when the system
# cleaned it. Both now have permanent homes, and this script finds them:
#
#   key        ./.dbx-repository-signing-key.env   (gitignored)  or  ~/.dbx-signing/*.env
#   packager   ~/.dbx-signing/bin/dbx-plugin-packager             or  DBX_PACKAGER
#
# Usage: scripts/sign.sh <version>
#   e.g. scripts/sign.sh 0.2.1
#
# It reads dist/<id>-<version>-darwin-x64.dbxp, writes the .signed.dbxp next to it, and
# rewrites the artifact metadata with the published URL, sha256 and size.
set -euo pipefail

VERSION="${1:?usage: scripts/sign.sh <version>}"
ID="io.github.southernmortals.board-games"
TARGET="darwin-x64"
BASE="dist/${ID}-${VERSION}-${TARGET}"
URL="https://raw.githubusercontent.com/southernMortals/dbx-plugins/main/releases/${VERSION}/${ID}-${VERSION}-${TARGET}.dbxp"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- locate the key -------------------------------------------------------------------
KEY_ENV=""
for candidate in "$ROOT/.dbx-repository-signing-key.env" "$HOME"/.dbx-signing/*.env; do
  if [ -f "$candidate" ]; then KEY_ENV="$candidate"; break; fi
done
if [ -z "$KEY_ENV" ]; then
  echo "no signing key found. Expected $ROOT/.dbx-repository-signing-key.env" >&2
  echo "Regenerate with: dbx-plugin keygen <KEY_ID> --output .dbx-repository-signing-key.env" >&2
  echo "Then publish the new public key in dbx-plugins/keys/ and the catalog." >&2
  exit 1
fi

# --- locate the packager --------------------------------------------------------------
PACKAGER="${DBX_PACKAGER:-}"
if [ -z "$PACKAGER" ]; then
  for candidate in "$HOME/.dbx-signing/bin/dbx-plugin-packager" \
                   /tmp/packager_db/plugins/sdk/packager/target/release/dbx-plugin-packager; do
    if [ -x "$candidate" ]; then PACKAGER="$candidate"; break; fi
  done
fi
if [ -z "$PACKAGER" ]; then
  echo "no packager found. Rebuild it with:" >&2
  echo "  git clone --depth 1 --filter=blob:none --sparse https://github.com/t8y2/dbx.git /tmp/packager_db" >&2
  echo "  cd /tmp/packager_db && git sparse-checkout set plugins/sdk/packager" >&2
  echo "  cd plugins/sdk/packager && cargo build --release" >&2
  echo "  cp target/release/dbx-plugin-packager ~/.dbx-signing/bin/" >&2
  exit 1
fi

if [ ! -f "${BASE}.dbxp" ]; then
  echo "missing ${BASE}.dbxp — run: dbx-plugin package ." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$KEY_ENV"

echo "key:      $DBX_PLUGIN_SIGNING_KEY_ID ($KEY_ENV)"
echo "packager: $PACKAGER"

"$PACKAGER" sign \
  "${BASE}.dbxp" \
  "${BASE}.signed.dbxp" \
  --key-id "$DBX_PLUGIN_SIGNING_KEY_ID" \
  --artifact-metadata "${BASE}.artifact.json" \
  --target "$TARGET" \
  --artifact-url "$URL"

echo "--- artifact ---"
cat "${BASE}.artifact.json"
echo
shasum -a 256 "${BASE}.signed.dbxp"
