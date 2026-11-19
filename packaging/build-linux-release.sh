#!/usr/bin/env bash
# Build both native executables against a glibc baseline that includes Ubuntu 20.04.
set -euo pipefail
cd "$(dirname "$0")/.."
arch=$(uname -m)
case "$arch" in
    x86_64|aarch64) ;;
    *) printf 'Unsupported Linux architecture: %s\n' "$arch" >&2; exit 2 ;;
esac

mkdir -p .tools/mujoco
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
    -e RUSTUP_HOME=/work/.tools/release-rustup -e CARGO_HOME=/work/.tools/release-cargo \
    -e MUJOCO_DOWNLOAD_DIR=/work/.tools/mujoco \
    "quay.io/pypa/manylinux_2_28_${arch}:2026.05.07-2" bash -euc '
      if [[ ! -x "$CARGO_HOME/bin/cargo" ]]; then
          curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh
          sh /tmp/rustup-init.sh -y --profile minimal --no-modify-path --default-toolchain 1.98.1
      fi
      "$CARGO_HOME/bin/cargo" build --release "$1"
      if [[ "$1" == --locked ]]; then
          /opt/python/cp312-cp312/bin/python -m venv .tools/dxl-build-venv
          .tools/dxl-build-venv/bin/python -m pip install --no-cache-dir -r dxl/requirements-build.txt
          .tools/dxl-build-venv/bin/python dxl/build.py
      fi
    ' bash "${1:---locked}"
