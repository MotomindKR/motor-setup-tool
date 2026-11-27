#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=3.17.0
dir="${MUJOCO_DOWNLOAD_DIR:-$PWD/.tools/mujoco}"
case "$(uname -s)" in
    Linux) asset="mujoco-$version-linux-$(uname -m).tar.gz" ;;
    Darwin) asset="mujoco-$version-macos-universal2.dmg" ;;
    MINGW*|MSYS*) asset="mujoco-$version-windows-$(uname -m).zip" ;;
    *) echo "This script supports Linux, macOS, and Windows with Git Bash." >&2; exit 1 ;;
esac
digest=$(awk -v asset="$asset" '$2 == asset {print $1}' packaging/mujoco.sha256)
[[ -n "$digest" ]] || { echo "Missing checksum for $asset" >&2; exit 1; }
mkdir -p "$dir"
cd "$dir"
sdk="$PWD/mujoco-$version"
verify() {
    if command -v sha256sum >/dev/null; then
        echo "$digest  $asset" | sha256sum -c -
    else
        echo "$digest  $asset" | shasum -a 256 -c -
    fi
}
if [[ ! -f "$asset" ]] || ! verify >/dev/null; then
    curl -fL --retry 3 -o "$asset" "https://github.com/google-deepmind/mujoco/releases/download/$version/$asset"
    verify
fi
if [[ "$asset" == *.dmg ]]; then
    mount=$(mktemp -d)
    hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$asset"
    trap 'hdiutil detach "$mount" && rmdir "$mount"' EXIT
    lib="libmujoco.$version.dylib"
    mkdir -p "$sdk/lib"
    cp "$mount/LICENSE" "$mount/THIRD_PARTY_NOTICES" "$sdk/"
    cp "$mount/mujoco.framework/Versions/A/$lib" "$sdk/lib/$lib"
    ln -sf "$lib" "$sdk/lib/libmujoco.dylib"
    install_name_tool -id "@rpath/$lib" "$sdk/lib/$lib"
    codesign --force --sign - --timestamp=none "$sdk/lib/$lib"
elif [[ "$asset" == *.zip ]]; then
    python -m zipfile -e "$asset" "mujoco-$version"
    sdk=$(cygpath -am "$sdk")
else
    tar -xzf "$asset"
fi
echo "MUJOCO_DYNAMIC_LINK_DIR=$sdk/lib"
if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "MUJOCO_DYNAMIC_LINK_DIR=$sdk/lib" >> "$GITHUB_ENV"
fi
