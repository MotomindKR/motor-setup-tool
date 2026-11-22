#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/ci}"
case "${RUNNER_OS:-Linux}" in
    Linux)
        mujoco_sdk=$(python3 packaging/fetch.py)
        export MUJOCO_DYNAMIC_LINK_DIR="$mujoco_sdk/lib"
        export LD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        ;;
    macOS)
        export DYLD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
        ;;
    Windows)
        export PATH="$PWD/.tools/mujoco/mujoco-3.12.0/bin:$PATH"
        ;;
esac
source scripts/check.sh
