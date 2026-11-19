"""Download the published stable installer immediately preceding a build."""

import os
import re
import subprocess
import sys
from pathlib import Path


def version_key(version):
    return tuple(map(int, version.split(".")))


if len(sys.argv) != 2:
    sys.exit("Expected exactly one installer")
installer = Path(sys.argv[1]).name
match = re.fullmatch(
    r"motor-setup-tool-(\d+\.\d+\.\d+)(?:[-+].+)?-(linux-(?:x64|arm64)\.deb|win32-x64\.exe)",
    installer,
)
if not match:
    sys.exit(f"Unrecognized installer name: {installer}")
version, target = match.groups()
current = version_key(version)

tags = subprocess.check_output([
    "gh", "api", "--paginate", "repos/{owner}/{repo}/releases?per_page=100",
    "--jq", ".[] | select(.prerelease or .draft | not) | .tag_name",
], text=True).splitlines()
stable = [tag[1:] for tag in tags if re.fullmatch(r"v\d+\.\d+\.\d+", tag)]
previous = max((v for v in stable if version_key(v) < current), key=version_key, default=None)
if previous is None:
    sys.exit(f"No published stable release precedes {version}")

asset = f"motor-setup-tool-{previous}-{target}"
destination = Path(os.environ["RUNNER_TEMP"]) / asset
subprocess.run(
    ["gh", "release", "download", f"v{previous}", "--pattern", asset, "--dir", destination.parent],
    check=True, stdout=sys.stderr,
)
print(destination)
