#!/usr/bin/env bash
# HWP 엔진(@rhwp/core, MIT)을 npm 에서 받아 앱 안(assets/www/engine/)에 넣는다.
# 26MB 바이너리를 저장소에 넣지 않으려고 빌드할 때마다 받는다. 버전과 무결성(sha512)을 고정해 바뀐 파일은 거부한다.
set -euo pipefail
VERSION="0.9.0"
INTEGRITY="sha512-dEe9gtEM5QXAoJjX+fwgbN5KIo0a6X/wgwEg0LDcq9oY1ga5lD5vNkediFSSX4Xxs8VfFk//dbk71aMQ8J1uAQ=="

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/app/src/main/assets/www/engine}"
if [ -f "$DEST/rhwp_bg.wasm" ] && [ "$(cat "$DEST/VERSION" 2>/dev/null)" = "$VERSION" ]; then
  echo "engine $VERSION already in $DEST"; exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack "@rhwp/core@$VERSION" --silent >/dev/null )
TGZ="$TMP/rhwp-core-$VERSION.tgz"
ACTUAL="sha512-$(openssl dgst -sha512 -binary "$TGZ" | base64 | tr -d '\n')"
if [ "$ACTUAL" != "$INTEGRITY" ]; then
  echo "engine integrity mismatch: $ACTUAL" >&2; exit 1
fi
mkdir -p "$TMP/x" && tar xzf "$TGZ" -C "$TMP/x" --strip-components=1
rm -rf "$DEST" && mkdir -p "$DEST"
cp "$TMP/x/rhwp.js" "$TMP/x/rhwp_bg.wasm" "$TMP/x/LICENSE" "$DEST/"
cp -r "$TMP/x/notices" "$DEST/notices"
echo "$VERSION" > "$DEST/VERSION"
echo "engine $VERSION -> $DEST"
