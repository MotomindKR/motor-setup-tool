#!/usr/bin/env python3
"""Exercise the registered launcher through GLib, as GNOME does (no motor I/O)."""
import os
from pathlib import Path
import sys
import time

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

app_id = 'com.motomind.MotorSetup'
data = Path(os.environ['XDG_DATA_HOME'])
launcher = data / 'applications' / (app_id + '.desktop')
installed = Gio.DesktopAppInfo.new(app_id + '.desktop')
assert installed is not None, 'Desktop cannot discover the installed application ID'
assert installed.get_startup_wm_class() == app_id
icon = installed.get_icon()
assert isinstance(icon, Gio.FileIcon), icon
assert Path(icon.get_file().get_path()).is_file(), 'Desktop icon does not resolve'

# Add capture-only arguments to a copy; leave the actual installed entry intact.
capture = Path(sys.argv[1]).resolve()
keyfile = GLib.KeyFile()
keyfile.load_from_file(str(launcher), GLib.KeyFileFlags.NONE)
keyfile.set_string('Desktop Entry', 'Exec', installed.get_commandline()
                   + f' "--screenshot={capture}" --screenshot-theme=light')
probe = Gio.DesktopAppInfo.new_from_keyfile(keyfile)
assert probe is not None
assert probe.launch([], None)
deadline = time.monotonic() + 35
while not capture.is_file() and time.monotonic() < deadline:
    time.sleep(0.1)
assert capture.is_file() and capture.stat().st_size > 0, 'Registered desktop launch failed'
print('Desktop application ID, resolved icon, and launch through GLib: OK')
