#!/usr/bin/env python3
"""Fetch architecture-specific release tools/SDK, verifying every downloaded byte."""
import hashlib
import json
import pathlib
import platform
import sys
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARCH = platform.machine()
LOCK = json.loads((ROOT / 'packaging/downloads.json').read_text())[ARCH]
CACHE = ROOT / '.tools/packaging' / ARCH


def fetch(name):
    spec = LOCK[name]
    path = CACHE / (name + '-' + spec['sha256'][:16])
    CACHE.mkdir(parents=True, exist_ok=True)
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != spec['sha256']:
        request = urllib.request.Request(spec['url'], headers={'Accept': 'application/octet-stream'})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != spec['sha256']:
            raise RuntimeError('SHA-256 mismatch: ' + name)
        path.write_bytes(data)
    return path


if __name__ == '__main__':
    archive = fetch('mujoco')
    destination = CACHE / 'sdk'
    # Only unpack this checksum-verified upstream archive into our cache.
    with tarfile.open(archive) as tar:
        tar.extractall(destination)
    print(destination / 'mujoco-3.12.0')
