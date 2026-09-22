# Linux release guide

[Developer guide](../docs/development.md) · [User documentation](../README.md)

## Publish a release

1. Set `package.version` in `Cargo.toml` and update `Cargo.lock` with Cargo.
2. Commit and push to `main`; check that unit-test CI passes.
3. Tag that commit with the matching version and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The [release workflow](../.github/workflows/release.yml) builds natively on
amd64 and arm64. Each architecture must pass formatting, Clippy, unit tests,
packaging, and clean Ubuntu 22.04/24.04 launch checks. The publication job then
uploads both AppImages and their SHA-256 files to a draft GitHub Release and
publishes it. A tag containing a hyphen creates a prerelease.

Tags must exactly match the Cargo version. Manual dispatch on a branch builds
artifacts without publishing; dispatch on a matching version tag can publish.
The workflow uses the built-in GitHub token with `contents: write` only in the
publication job. It requires available Actions runners and billing capacity.

Release assets:

- `motor-setup-tool-VERSION-linux-amd64.AppImage`
- `motor-setup-tool-VERSION-linux-arm64.AppImage`
- A `.sha256` file for each AppImage

## Build locally

From the repository root on an amd64 or arm64 Linux host with Docker:

```sh
docker build -f packaging/Dockerfile -t motomind-packager .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/work/.tools/ci-cargo -v "$PWD:/work" \
  motomind-packager bash scripts/build-appimage.sh
```

Output is written to `dist/` for the host architecture. The script runs
[scripts/check.sh](../scripts/check.sh) before creating the release build.
Cross-compilation is not needed for the two native CI jobs.

The baseline is Ubuntu 22.04 / glibc 2.35. The Docker image digest, Rust 1.98.1,
Cargo dependencies, MuJoCo SDK, AppImage tool, and runtime hashes are pinned.
Ubuntu security packages are resolved at build time; this is not a claim of
byte-for-byte reproducible builds.

## Package contents

`package.py` assembles the AppDir with:

- The release binary and MuJoCo 3.12.0.
- Desktop libraries loaded by egui/winit, including those missed by `ldd` alone.
- The desktop entry, motor/Motomind app icon, third-party license texts, and build metadata.

The binary is `usr/bin/motor-setup-tool`. The desktop entry and window application
ID both use `com.motomind.MotorSetup`. The icon is included as SVG and 16–512 px
PNGs under `usr/share/icons/hicolor`, with a root icon and `.DirIcon` for AppImage
launchers. See [assets](../assets/README.md) to regenerate the PNGs.

On GUI startup, an AppImage registers its desktop entry and icons under
`$XDG_DATA_HOME` (default `~/.local/share`). This lets GNOME/Wayland match the
window's application ID; assets inside the temporary AppImage mount alone are
not discoverable by the desktop. The launcher targets the original AppImage,
not its temporary binary path, and refreshes when a moved/new version is opened.
`--install-desktop` performs the same registration without opening a window.
Development binaries and passive CLI checks do not register a launcher.

The executable searches `$ORIGIN/../lib`; bundled libraries search `$ORIGIN`.
System glibc, the ELF loader, and OpenGL driver/dispatch stay on the host.
Packaging rejects GLIBC requirements newer than 2.35. The AppImage runtime and
SDK downloads are verified against [downloads.json](downloads.json).

User data belongs outside the AppImage. Directory conventions and artifact
semantics are documented in the [user guide](../docs/user-guide.md#open-and-refit-recordings)
and [simulation reference](../docs/simulation.md). Preserve the app's existing
persistence identity when changing display or repository names.

## Verify the package

```sh
docker build -f packaging/Dockerfile.smoke -t motomind-smoke .
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/dist:/input:ro" \
  motomind-smoke /input/motor-setup-tool-VERSION-linux-amd64.AppImage
```

Use the actual version and architecture in the filename. Set Docker build
argument `BASE=ubuntu:24.04` to test the second runtime used by release CI.

The smoke test relocates the AppImage into a path containing spaces, unsets
development library paths, and uses fresh user directories. It checks MuJoCo
stepping, writable data paths, passive CAN enumeration, and light/dark rendering
under Xvfb with software OpenGL. It also resolves the installed icon and launches
the app through GLib's desktop-entry loader, including after relocation to a
filename containing spaces, percent signs, quotes, and other reserved characters.
Only `dist/` is mounted: source code and the
developer's toolchain are inaccessible. It does not operate a motor.

Real adapter/firmware behavior and GPU/Wayland integration require separate
hardware checks. The host must supply the CAN driver and configured interface;
packaging does not install a driver or grant network-administration privileges.

## Update bundled dependencies

Update both architecture entries in `downloads.json` with upstream release
hashes. Keep MuJoCo synchronized across `mujoco-rs`, `build.rs`, and
`engine::VERSION`. Preserve library/font license texts and update supplemental
notices when crate versions change. A baseline change must update the Docker
image, GLIBC assertion, smoke tests, and release notes together.
