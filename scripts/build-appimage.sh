#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/appimage}"
# Always use our SHA-256 verified SDK; disable the crate's implicit download.
mujoco_sdk=$(python3 packaging/fetch.py)
export MUJOCO_DYNAMIC_LINK_DIR="$mujoco_sdk/lib"
export LD_LIBRARY_PATH="$MUJOCO_DYNAMIC_LINK_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
bash scripts/check.sh
cargo build --locked --release
python3 packaging/package.py "$CARGO_TARGET_DIR/release/motomind-motor-calib" "$mujoco_sdk"
