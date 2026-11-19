#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Run inside manylinux: its bundled Python has no libpython for PyInstaller.
python_version=3.12.16
python_sha256=b5796915dc45ff745cfb4e990a7e7c93d6f546328a102ce31448d69ebc37575c
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
prefix="$build_dir/python"
archive="$build_dir/Python-$python_version.tar.xz"

curl -fsSL --retry 3 "https://www.python.org/ftp/python/$python_version/Python-$python_version.tar.xz" -o "$archive"
printf '%s  %s\n' "$python_sha256" "$archive" | sha256sum --check
tar -xJf "$archive" -C "$build_dir"
(
    cd "$build_dir/Python-$python_version"
    ./configure --prefix="$prefix" --enable-shared --without-static-libpython
    make -j"$(nproc)"
    make install
    cp LICENSE "$prefix/LICENSE.txt"
)

export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PYINSTALLER_CONFIG_DIR="$build_dir/pyinstaller"
"$prefix/bin/python3" -m venv "$build_dir/venv"
"$build_dir/venv/bin/python" -m pip install --no-cache-dir -r dxl/requirements-build.txt
"$build_dir/venv/bin/python" dxl/build.py
