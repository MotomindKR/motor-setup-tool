#!/usr/bin/env python3
"""Build an AppDir explicitly, including egui's dlopen-only desktop libraries."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from fetch import ARCH, ROOT, fetch


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


binary, sdk = map(lambda p: Path(p).resolve(), sys.argv[1:])
metadata = json.loads(run('cargo', 'metadata', '--locked', '--format-version=1',
                          '--filter-platform', ARCH + '-unknown-linux-gnu'))
package = next(p for p in metadata['packages'] if p['name'] == 'motomind-motor-calib')
version = package['version']
label = {'x86_64': 'amd64', 'aarch64': 'arm64'}[ARCH]
dist = ROOT / 'dist'
app = dist / (label + '.AppDir')
if app.exists():
    shutil.rmtree(app)
lib = app / 'usr/lib'
exe = app / 'usr/bin/motomind-motor-calib'
licenses = app / 'usr/share/licenses/motomind-motor-calib'
lib.mkdir(parents=True)
exe.parent.mkdir(parents=True)
licenses.mkdir(parents=True)
shutil.copy2(binary, exe)
shutil.copy2(ROOT / 'packaging/AppRun', app / 'AppRun')
icon = 'com.motomind.MotorSetup'
shutil.copy2(ROOT / ('packaging/' + icon + '.desktop'), app)
shutil.copy2(ROOT / 'assets/motomind-logo.svg', app / (icon + '.svg'))
(app / '.DirIcon').symlink_to(icon + '.svg')
run('desktop-file-validate', str(app / (icon + '.desktop')))

triplet = run('gcc', '-dumpmachine')
# The graphics driver/GL dispatch comes from the host. Bundle windowing and
# keyboard libraries, which winit loads dynamically (ldd alone misses them).
seeds = [sdk / 'lib/libmujoco.so.3.12.0']
for name in ['libX11.so.6', 'libXcursor.so.1', 'libXi.so.6', 'libXrandr.so.2',
             'libXinerama.so.1', 'libXrender.so.1', 'libXfixes.so.3',
             'libxkbcommon.so.0', 'libxkbcommon-x11.so.0',
             'libwayland-client.so.0', 'libwayland-cursor.so.0', 'libwayland-egl.so.1']:
    seeds.append(Path('/usr/lib') / triplet / name)
# ABI baseline libraries and graphics drivers MUST stay on the host.
excluded = re.compile(r'^(ld-linux.*|lib(c|m|pthread|dl|rt|resolv|util)\.so\..*|lib(GL|EGL|GLX|GLdispatch)\.so\..*)$')
libraries = {p.name: p for p in seeds}
for seed in [binary] + seeds:
    output = run('ldd', str(seed))
    if 'not found' in output:
        raise RuntimeError(output)
    for line in output.splitlines():
        match = re.search(r'(\S+) => (/\S+)', line)
        if match and not excluded.match(match[1]):
            libraries[match[1]] = Path(match[2])
for name, source in sorted(libraries.items()):
    shutil.copy2(source, lib / name)
    run('patchelf', '--set-rpath', '$ORIGIN', str(lib / name))
run('patchelf', '--set-rpath', '$ORIGIN/../lib', str(exe))
# Reject dependencies that would raise the supported glibc floor above 2.35.
for elf in [exe] + list(lib.iterdir()):
    required = re.findall(r'Name: GLIBC_(\d+)\.(\d+)', run('readelf', '--version-info', str(elf)))
    if any(tuple(map(int, v)) > (2, 35) for v in required):
        raise RuntimeError('Exceeds Ubuntu 22.04 glibc baseline: ' + str(elf))

shutil.copy2(sdk / 'LICENSE', licenses / 'MuJoCo-LICENSE')
shutil.copy2(sdk / 'THIRD_PARTY_NOTICES', licenses / 'MuJoCo-THIRD_PARTY_NOTICES')
shutil.copy2(ROOT / 'assets/fonts/OFL.txt', licenses / 'Pretendard-OFL.txt')
shutil.copy2(ROOT / 'assets/README.md', licenses / 'Brand-assets.md')
shutil.copytree('/usr/share/common-licenses', licenses / 'system-common-licenses')
# Preserve the full published crate license files plus SPDX/source inventory.
inventory = []
for p in sorted(metadata['packages'], key=lambda p: (p['name'], p['version'])):
    if p['source'] is None:
        continue
    directory = Path(p['manifest_path']).parent
    target = licenses / 'rust' / (p['name'] + '-' + p['version'])
    target.mkdir(parents=True)
    shutil.copy2(directory / 'Cargo.toml', target / 'Cargo.toml')
    files = [f for f in directory.rglob('*') if f.is_file() and
             (any(word in f.name.upper() for word in ('LICENSE', 'LICENCE', 'COPYING', 'COPYRIGHT', 'NOTICE'))
              or f.name in ('OFL.txt', 'UFL.txt', 'Hack-Regular.txt'))]
    if p.get('license_file'):
        files.append(directory / p['license_file'])
    for f in set(files):
        if f.is_file():
            output = target / f.relative_to(directory)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, output)
    supplemental = ROOT / 'packaging/licenses' / target.name
    if supplemental.exists():
        shutil.copytree(supplemental, target, dirs_exist_ok=True)
    if not any(f.is_file() and f.name not in ('Cargo.toml', 'SOURCE.txt') for f in target.rglob('*')):
        raise RuntimeError('Missing license files for ' + target.name)
    inventory.append({k: p.get(k) for k in ('name', 'version', 'license', 'repository')})
(licenses / 'rust-dependencies.json').write_text(json.dumps(inventory, indent=2) + '\n')
for source in libraries.values():
    if source.is_relative_to(sdk):
        continue
    # Ubuntu's merged /usr can report a different path spelling than ldd.
    lookup = source.resolve()
    candidates = [str(source), str(lookup)]
    if str(lookup).startswith('/usr/'):
        candidates.append(str(lookup)[4:])
    matches = []
    for candidate in dict.fromkeys(candidates):
        result = subprocess.run(['dpkg-query', '-S', candidate], text=True, capture_output=True)
        if result.returncode == 0:
            matches = result.stdout.splitlines()
            break
    if not matches:
        raise RuntimeError('Cannot identify library package: ' + str(source))
    owner = matches[0].split(': ')[0]
    copyright_file = Path('/usr/share/doc') / owner.split(':')[0] / 'copyright'
    if not copyright_file.exists():
        raise RuntimeError('Missing library license: ' + str(source))
    shutil.copy2(copyright_file, licenses / (owner.replace(':', '-') + '-copyright'))
(licenses / 'README.txt').write_text(
    'Third-party notices for Motomind Motor Calibration / Setup.\n'
    'Rust dependency inventory includes transitive/build dependencies.\n'
    'System library copyright files reference system-common-licenses/.\n'
    'The AppImage runtime is MIT licensed; see AppImage-runtime-LICENSE.\n')
shutil.copy2(ROOT / 'packaging/AppImage-runtime-LICENSE', licenses)
manifest = {'version': version, 'architecture': label, 'baseline': 'Ubuntu 22.04 / glibc 2.35',
            'rust': run('rustc', '--version'), 'mujoco': '3.12.0',
            'libraries': sorted(libraries), 'source': os.environ.get('GITHUB_SHA', 'local')}
(app / 'usr/share/build-info.json').write_text(json.dumps(manifest, indent=2) + '\n')
# Pin runtime separately: appimagetool must never fetch a mutable latest binary.
tool, runtime = fetch('appimagetool'), fetch('runtime')
tool.chmod(0o755)
output = dist / f'Motomind-Motor-Setup-{version}-linux-{label}.AppImage'
env = dict(os.environ, ARCH=ARCH, APPIMAGE_EXTRACT_AND_RUN='1')
subprocess.run([str(tool), '--runtime-file', str(runtime), str(app), str(output)], env=env, check=True)
output.chmod(0o755)
(dist / (output.name + '.sha256')).write_text(hashlib.sha256(output.read_bytes()).hexdigest() + '  ' + output.name + '\n')
print(output)
