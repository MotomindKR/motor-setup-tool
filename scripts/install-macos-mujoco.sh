#!/usr/bin/env bash
set -euo pipefail
sdk="${MUJOCO_DOWNLOAD_DIR:-$PWD/.tools/mujoco}/mujoco-3.12.0/lib"
mkdir -p "$sdk" "$RUNNER_TEMP/mujoco-mount"
asset=mujoco-3.12.0-macos-universal2.dmg
base=https://github.com/google-deepmind/mujoco/releases/download/3.12.0
curl -fL --retry 3 -o "$RUNNER_TEMP/$asset" "$base/$asset"
curl -fL --retry 3 -o "$RUNNER_TEMP/$asset.sha256" "$base/$asset.sha256"
(cd "$RUNNER_TEMP" && shasum -a 256 -c "$asset.sha256")
hdiutil attach -nobrowse -readonly -mountpoint "$RUNNER_TEMP/mujoco-mount" "$RUNNER_TEMP/$asset"
trap 'hdiutil detach "$RUNNER_TEMP/mujoco-mount"' EXIT
source_lib="$(find "$RUNNER_TEMP/mujoco-mount" -name libmujoco.3.12.0.dylib -type f -print -quit)"
test -n "$source_lib"
cp "$source_lib" "$sdk/libmujoco.3.12.0.dylib"
ln -sf libmujoco.3.12.0.dylib "$sdk/libmujoco.dylib"
install_name_tool -id @rpath/libmujoco.3.12.0.dylib "$sdk/libmujoco.3.12.0.dylib"
codesign --force --sign - --timestamp=none "$sdk/libmujoco.3.12.0.dylib"
echo "MUJOCO_DYNAMIC_LINK_DIR=$sdk" >> "$GITHUB_ENV"
