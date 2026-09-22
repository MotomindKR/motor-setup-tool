#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -x .tools/cargo/bin/cargo ]]; then
    export CARGO_HOME="$PWD/.tools/cargo"
    export RUSTUP_HOME="$PWD/.tools/rustup"
    export PATH="$CARGO_HOME/bin:$PATH"
fi
if [[ -d .tools/system-libs/usr/lib/x86_64-linux-gnu ]]; then
    export LD_LIBRARY_PATH="$PWD/.tools/system-libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
exec cargo run --locked -- "$@"
