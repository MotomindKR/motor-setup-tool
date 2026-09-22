#!/usr/bin/env bash
# Run inside a clean desktop-runtime container, with only the release mounted.
set -euo pipefail
artifact=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home" "$work/data" "$work/cache" "$work/config" "$work/runtime" "$work/relocated app"
chmod 700 "$work/runtime"
export HOME="$work/home" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache"
export XDG_CONFIG_HOME="$work/config" XDG_RUNTIME_DIR="$work/runtime"
export APPIMAGE_EXTRACT_AND_RUN=1 LIBGL_ALWAYS_SOFTWARE=1
unset LD_LIBRARY_PATH MUJOCO_DYNAMIC_LINK_DIR MUJOCO_DOWNLOAD_DIR CARGO_HOME RUSTUP_HOME
cp "$artifact" "$work/relocated app/motor.AppImage"
chmod +x "$work/relocated app/motor.AppImage"
cd /
"$work/relocated app/motor.AppImage" --version
"$work/relocated app/motor.AppImage" --self-check > "$work/check.json"
python3 - "$work/check.json" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1]))
assert r['mujoco'] == '3.12.0'
assert r['data'] == os.environ['XDG_DATA_HOME'] + '/motomind-motor-calib'
assert r['cache'] == os.environ['XDG_CACHE_HOME'] + '/motomind-motor-calib'
assert r['locks'] == r['data'] + '/can-locks'
print('Relocated binary, bundled MuJoCo, XDG paths and passive CAN enumeration: OK')
PY
for theme in light dark; do
    timeout 45s dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
        "$work/relocated app/motor.AppImage" --screenshot="$work/$theme.png" --screenshot-theme="$theme"
    test -s "$work/$theme.png"
done
if [[ -n "${SMOKE_OUTPUT:-}" ]]; then
    mkdir -p "$SMOKE_OUTPUT"
    cp "$work/check.json" "$work/light.png" "$work/dark.png" "$SMOKE_OUTPUT/"
fi
printf 'Light and dark desktop rendering: OK\n'
