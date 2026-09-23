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
pids = []
assert probe.launch_uris_as_manager(
    [], None, GLib.SpawnFlags.DO_NOT_REAP_CHILD, None, None,
    lambda _app, pid, _data: pids.append(pid), None,
)
assert len(pids) == 1, 'Expected one desktop process'
deadline = time.monotonic() + 35
status = None
while time.monotonic() < deadline:
    pid, child_status = os.waitpid(pids[0], os.WNOHANG)
    if pid:
        status = child_status
        break
    time.sleep(0.1)
assert status is not None, 'Registered desktop process did not exit after capture'
assert os.waitstatus_to_exitcode(status) == 0, f'Desktop process failed: {status}'
assert capture.is_file() and capture.stat().st_size > 0, 'Registered desktop launch failed'
print('Desktop application ID, resolved icon, and launch through GLib: OK')
