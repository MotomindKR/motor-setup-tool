#!/usr/bin/env python3
"""Fetch architecture-specific release tools/SDK, verifying every downloaded byte."""
import hashlib
import http.client
import json
import os
import pathlib
import platform
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARCH = platform.machine()
LOCK = json.loads((ROOT / 'packaging/downloads.json').read_text())[ARCH]
CACHE = ROOT / '.tools/packaging' / ARCH


def download_request(url):
    request = urllib.request.Request(url, headers={'Accept': 'application/octet-stream'})
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if token and urllib.parse.urlsplit(url).netloc == 'api.github.com' and request.type == 'https':
        # GitHub redirects assets to a signed CDN URL. Keep the token on the
        # initial API request only; never forward it to the download host.
        request.add_unredirected_header('Authorization', 'Bearer ' + token)
    return request


def download(url, name):
    for attempt in range(5):
        delay = 2 ** (attempt + 1)
        try:
            with urllib.request.urlopen(download_request(url), timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            limited = error.code == 403 and (
                error.headers.get('X-RateLimit-Remaining') == '0'
                or error.headers.get('Retry-After') is not None
                or 'rate limit' in str(error.reason).lower())
            if attempt == 4 or not (limited or error.code in (408, 429, 500, 502, 503, 504)):
                raise
            retry_after = error.headers.get('Retry-After', '')
            if retry_after.isdigit():
                delay = max(delay, min(int(retry_after), 60))
            error.close()
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
            if attempt == 4:
                raise
        print(f'Retrying {name} download in {delay}s ({attempt + 2}/5).', file=sys.stderr)
        time.sleep(delay)


def fetch(name):
    spec = LOCK[name]
    path = CACHE / (name + '-' + spec['sha256'][:16])
    CACHE.mkdir(parents=True, exist_ok=True)
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != spec['sha256']:
        data = download(spec['url'], name)
        if hashlib.sha256(data).hexdigest() != spec['sha256']:
            raise RuntimeError('SHA-256 mismatch: ' + name)
        path.write_bytes(data)
    return path


if __name__ == '__main__':
    # Fetch every packaging dependency before spending time compiling Rust.
    if sys.argv[1:] == ['--all']:
        fetch('appimagetool')
        fetch('runtime')
    archive = fetch('mujoco')
    destination = CACHE / 'sdk'
    # Only unpack this checksum-verified upstream archive into our cache.
    with tarfile.open(archive) as tar:
        tar.extractall(destination)
    print(destination / 'mujoco-3.12.0')
