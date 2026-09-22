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
# Verify the desktop launch target and icons from the actual release artifact.
cd "$work"
"$work/relocated app/motor.AppImage" --appimage-extract > /dev/null
python3 - "$work/squashfs-root" <<'PY'
import configparser, os, pathlib, struct, sys, xml.etree.ElementTree as ET
app = pathlib.Path(sys.argv[1])
desktop_id = 'com.motomind.MotorSetup'
entry = configparser.ConfigParser(interpolation=None)
entry.read(app / (desktop_id + '.desktop'))
desktop = entry['Desktop Entry']
assert desktop['Exec'] == 'motor-setup-tool'
assert desktop['Icon'] == desktop_id
assert desktop['StartupWMClass'] == desktop_id
assert os.access(app / 'usr/bin/motor-setup-tool', os.X_OK)
assert (app / 'usr/share/applications' / (desktop_id + '.desktop')).is_file()
assert (app / '.DirIcon').resolve() == app / (desktop_id + '.png')
theme = app / 'usr/share/icons/hicolor'
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    png = (theme / f'{size}x{size}/apps' / (desktop_id + '.png')).read_bytes()
    assert png[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', png[16:24]) == (size, size)
assert (app / '.DirIcon').read_bytes() == (theme / '256x256/apps' / (desktop_id + '.png')).read_bytes()
svg = ET.parse(theme / 'scalable/apps' / (desktop_id + '.svg')).getroot()
assert svg.attrib['viewBox'] == '0 0 512 512'
print('Desktop executable, application ID, and scalable/raster icons: OK')
PY
cd /
"$work/relocated app/motor.AppImage" --version
"$work/relocated app/motor.AppImage" --self-check > "$work/check.json"
python3 - "$work/check.json" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1]))
assert r['name'] == 'motor-setup-tool'
assert r['mujoco'] == '3.12.0'
assert r['data'] == os.environ['XDG_DATA_HOME'] + '/motomind-motor-calib'
assert r['cache'] == os.environ['XDG_CACHE_HOME'] + '/motomind-motor-calib'
assert r['locks'] == r['data'] + '/can-locks'
print('Relocated binary, bundled MuJoCo, XDG paths and passive CAN enumeration: OK')
PY
test ! -e "$XDG_DATA_HOME/applications/com.motomind.MotorSetup.desktop"
for theme in light dark; do
    timeout 45s dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
        "$work/relocated app/motor.AppImage" --screenshot="$work/$theme.png" --screenshot-theme="$theme"
    test -s "$work/$theme.png"
done
timeout 45s dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
    python3 /usr/local/bin/verify-motomind-desktop "$work/desktop.png"
# A moved AppImage must refresh the launcher. Exercise literal percent/quoting
# characters through the real desktop parser, not a hand-written approximation.
python3 - "$work/relocated app/motor.AppImage" <<'PY'
from pathlib import Path
import subprocess, sys
old = Path(sys.argv[1])
new = old.with_name('motor 100% $literal `tick` "quote" \\slash.AppImage')
old.rename(new)
subprocess.run([str(new), '--install-desktop'], check=True)
PY
timeout 45s dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
    python3 /usr/local/bin/verify-motomind-desktop "$work/desktop-moved.png"
if [[ -n "${SMOKE_OUTPUT:-}" ]]; then
    mkdir -p "$SMOKE_OUTPUT"
    cp "$work/check.json" "$work/light.png" "$work/dark.png" \
        "$work/desktop.png" "$work/desktop-moved.png" "$SMOKE_OUTPUT/"
fi
printf 'Light and dark desktop rendering: OK\n'
