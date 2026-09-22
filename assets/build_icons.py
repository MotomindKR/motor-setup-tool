#!/usr/bin/env python3
"""Rasterize the launcher SVG with librsvg (python3-gi, librsvg2-common)."""
from pathlib import Path

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf  # noqa: E402

root = Path(__file__).resolve().parent
output = root / "icons"
output.mkdir(exist_ok=True)
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    image = GdkPixbuf.Pixbuf.new_from_file_at_scale(
        str(root / "motor-setup-tool.svg"), size, size, True
    )
    image.savev(str(output / f"{size}.png"), "png", [], [])
