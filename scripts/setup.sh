#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null && [[ ! -x .tools/cargo/bin/cargo ]]; then
    mkdir -p .tools
    curl -fsSL https://sh.rustup.rs -o .tools/rustup-init.sh
    CARGO_HOME="$PWD/.tools/cargo" RUSTUP_HOME="$PWD/.tools/rustup" \
        sh .tools/rustup-init.sh -y --no-modify-path --profile minimal
fi
if [[ -x .tools/cargo/bin/cargo ]]; then
    export CARGO_HOME="$PWD/.tools/cargo"
    export RUSTUP_HOME="$PWD/.tools/rustup"
    export PATH="$CARGO_HOME/bin:$PATH"
fi
cargo build --locked
