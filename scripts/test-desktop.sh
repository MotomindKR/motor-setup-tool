#!/usr/bin/env bash
# Prepare an isolated Motor Setup Tool test app on macOS or Ubuntu.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
    printf '%s\n' 'Usage: bash scripts/test-desktop.sh --setup | --check | --run [Electron flags]'
}

action=${1:-}
case "$action" in
    --setup|--check|--run) shift ;;
    *) usage; exit 2 ;;
esac

platform=$(uname -s)
case "$platform" in
    Darwin) default_sdk="$PWD/.tools/mujoco/mujoco-3.12.0/lib" ;;
    Linux) default_sdk="$PWD/.tools/packaging/$(uname -m)/sdk/mujoco-3.12.0/lib" ;;
    *) printf 'Unsupported test platform: %s\n' "$platform" >&2; exit 1 ;;
esac

export MUJOCO_DYNAMIC_LINK_DIR="${MUJOCO_DYNAMIC_LINK_DIR:-$default_sdk}"
export MOTOMIND_DXL_PYTHON="$PWD/.tools/dxl-test-venv/bin/python"
export MOTOMIND_TEST_USER_DATA="$PWD/.tools/desktop-test-user-data"
test_backend="${MOTOMIND_BACKEND:-$PWD/target/release/motor-setup-tool}"

configure_macos_sdk() {
    local sdk="$MUJOCO_DYNAMIC_LINK_DIR" bundled staging asset base source
    bundled='/Applications/Motor Setup Tool.app/Contents/Resources/backend/lib/libmujoco.3.12.0.dylib'
    mkdir -p "$sdk"
    if [[ ! -f "$sdk/libmujoco.3.12.0.dylib" ]]; then
        if [[ -f "$bundled" ]]; then
            cp "$bundled" "$sdk/libmujoco.3.12.0.dylib"
        else
            staging=$(mktemp -d "$PWD/.tools/mujoco-sdk.XXXXXX")
            asset=mujoco-3.12.0-macos-universal2.dmg
            base=https://github.com/google-deepmind/mujoco/releases/download/3.12.0
            curl -fL --retry 3 -o "$staging/$asset" "$base/$asset"
            curl -fL --retry 3 -o "$staging/$asset.sha256" "$base/$asset.sha256"
            (cd "$staging" && shasum -a 256 -c "$asset.sha256")
            mkdir "$staging/mount"
            hdiutil attach -nobrowse -readonly -mountpoint "$staging/mount" "$staging/$asset"
            source=$(find "$staging/mount" -name libmujoco.3.12.0.dylib -type f -print -quit)
            if [[ -z "$source" ]]; then
                hdiutil detach "$staging/mount"
                printf 'MuJoCo 3.12.0 library missing from the SDK DMG.\n' >&2
                return 1
            fi
            cp "$source" "$sdk/libmujoco.3.12.0.dylib"
            hdiutil detach "$staging/mount"
        fi
    fi
    if [[ "$sdk" == "$default_sdk" ]] && ! codesign --verify "$sdk/libmujoco.3.12.0.dylib" 2>/dev/null; then
        codesign --force --sign - --timestamp=none "$sdk/libmujoco.3.12.0.dylib"
    fi
    ln -sfn libmujoco.3.12.0.dylib "$sdk/libmujoco.dylib"
}

if [[ "$action" == --setup ]]; then
    python3 -c 'import sys; sys.exit("Python 3.10 or newer is required") if sys.version_info < (3, 10) else None'
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js 22.12 or newer is required"); process.exit(1); }'
    mkdir -p .tools
    python3 -m venv .tools/dxl-test-venv
    "$MOTOMIND_DXL_PYTHON" -m pip install -r dxl/requirements.txt pytest
    npm --prefix electron ci

    if [[ -z "${MOTOMIND_BACKEND:-}" ]]; then
        if [[ "$platform" == Darwin ]]; then
            configure_macos_sdk
        elif [[ ! -f "$MUJOCO_DYNAMIC_LINK_DIR/libmujoco.so.3.12.0" && "$MUJOCO_DYNAMIC_LINK_DIR" == "$default_sdk" ]]; then
            python3 packaging/fetch.py
        fi
        bash scripts/setup.sh
    fi
fi

if [[ ! -x "$MOTOMIND_DXL_PYTHON" || ! -x electron/node_modules/.bin/electron || ! -x "$test_backend" ]]; then
    printf 'Run %s --setup before testing.\n' "$0" >&2
    exit 1
fi

if [[ "$action" == --run ]]; then
    mkdir -p "$MOTOMIND_TEST_USER_DATA"
    exec npm --prefix electron start -- "$@"
fi

if [[ "$platform" == Darwin ]]; then
    DYLD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" "$test_backend" self-check
else
    LD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$test_backend" self-check
fi

if [[ "$action" == --check ]]; then
    "$MOTOMIND_DXL_PYTHON" -m pytest -q -o pythonpath=dxl dxl/tests
    npm --prefix electron run check
fi
