#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/ci}"
case "${RUNNER_OS:-Linux}" in
    Linux)
        export LD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        ;;
    macOS)
        export DYLD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
        ;;
    Windows)
        export PATH="$(cygpath -u "$MUJOCO_DYNAMIC_LINK_DIR")/../bin:$PATH"
        ;;
esac
source scripts/check.sh
