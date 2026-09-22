# Developer guide

[User documentation](../README.md) · [Identification](identification.md) ·
[Protocol](protocol.md) · [Release packaging](../packaging/README.md)

## Build and run

Use Linux, Rust 1.95 or newer, and a C compiler/linker. CI pins Rust 1.98.1.
On Ubuntu/Debian, install the build and desktop dependencies:

```sh
sudo apt-get install build-essential pkg-config libxkbcommon-x11-0 \
  libxcb-xkb1 libgl1 libegl1 libwayland-client0
./scripts/setup.sh
./scripts/run.sh
```

`setup.sh` installs a workspace-local Rust toolchain if no usable Cargo is
available. `run.sh` selects that toolchain when present. Cargo downloads the
version-matched MuJoCo library into `.tools/mujoco/`; `Cargo.lock` pins Rust
crates. Development builds include the downloaded library's path. Release
builds use a relative library path and must be packaged with MuJoCo.

Opening the app does not start motor motion. Use a real saved run to work on
results/UI without hardware:

```sh
./scripts/run.sh --open=/path/to/run
```

## Checks

With Cargo on `PATH`:

```sh
rustup component add rustfmt clippy
./scripts/check.sh
```

If using the workspace-local toolchain, first set:

```sh
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
```

The script runs formatting, Clippy with warnings denied, and unit tests. Tests
cover protocol encoding, rejected inputs, command limits, MuJoCo replay,
parameter recovery, held-out acceptance, cancellation, and UI theme contrast.
They require no motor and send no frames to a physical CAN bus. The explicitly
ignored `vcalwatch` test needs an isolated virtual CAN interface; normal CI does
not enable it.

[Unit tests](../.github/workflows/tests.yml) run on every push to `main`, pull
requests targeting `main`, and manual dispatch. The workflow uses the Ubuntu
22.04 build container and a verified MuJoCo SDK. It does not publish a release.
[Release CI](../.github/workflows/release.yml) additionally builds and tests
native amd64/arm64 AppImages when a matching version tag is pushed.

For the same environment locally:

```sh
docker build -f packaging/Dockerfile -t motomind-packager .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/work/.tools/ci-cargo -v "$PWD:/work" \
  motomind-packager bash scripts/check-ci.sh
```

## Code map

| Module | Responsibility |
|---|---|
| `app.rs`, `theme.rs` | UI, worker events, plots, shared appearance tokens |
| `hardware.rs` | SocketCAN discovery, acquisition, stop conditions, bus ownership |
| `protocol.rs`, `firmware.rs` | Frame encoding/decoding and firmware transfer |
| `types.rs`, `experiment.rs` | Profiles, configuration, motion generation, progress |
| `fit.rs` | Training-only parameter estimation |
| `engine.rs` | Native MuJoCo models and command-history replay |
| `pipeline.rs` | Input validation, acceptance, reports, and exports |
| `bridge.rs`, `paths.rs` | Artifact I/O and user directories |

The UI sends work to a background worker. Recording and fitting emit typed
progress events. The motor loop has its own timing and cancellation checks;
rendering and theme detection do not run inside it. Plot styling and legends
are shared through `styled_plot`.

## Changes that affect results

Keep these invariants when changing acquisition or fitting:

- Identify and validate the motor's firmware family before enabling it.
- Preserve the zero-torque watchdog preflight, limits, stale-feedback checks,
  cancellation, and stop-on-exit behavior.
- Record the transmitted, quantized command and its timestamp. Replay recorded
  commands rather than regenerating waveforms from current settings.
- Use training data to select parameters. Validation data must not select a
  seed, tune a parameter, or choose between candidates.
- Keep original saved profiles and samples intact. Refitting may replace
  analysis artifacts, but must not silently rescale measurements.
- Export accepted calibration files only when the acceptance checks pass.

Use the [protocol reference](protocol.md) when adding a model or changing wire
ranges, and the [identification reference](identification.md) for solver and
replay behavior.

## Visual review

Capture the native UI with a working desktop display:

```sh
./scripts/run.sh --open=/path/to/run --screenshot=/tmp/light.png --screenshot-theme=light
./scripts/run.sh --open=/path/to/run --screenshot=/tmp/dark.png --screenshot-theme=dark
```

The capture process closes after saving. These commands only open saved data.
Check graph legends, axis labels, units, clipping, and both theme palettes.
For fitting progress, use a copy of a real run because refit rewrites artifacts:

```sh
./scripts/run.sh --refit=/path/to/copied/run \
  --screenshot=/tmp/fitting.png --screenshot-during-fit
```

This captures the progress bar, then lets fitting finish before closing.
Screenshot theme overrides affect only the capture process. System appearance
comes from the XDG Settings portal over D-Bus, with the window system/egui
fallback when unavailable. Fonts and branding are embedded; see
[asset provenance and licenses](../assets/README.md).

## Command-line reference

Run these options with `./scripts/run.sh` or the packaged AppImage:

| Option | Effect |
|---|---|
| `--version` | Print the app version |
| `--list-can` | List CAN interfaces without sending motor commands |
| `--self-check` | Check MuJoCo, writable data paths, theme lookup, and passive CAN discovery |
| `--open=/path/to/run` | Open saved graphs |
| `--analyze=/path/to/run` | Refit saved data without a window; replaces analysis artifacts |
| `--refit=/path/to/run` | Refit saved data in the UI |
| `--connect=can0` | Open the UI and scan the selected idle bus |
| `--scan=can0` | Scan motor identities and firmware from the terminal |
| `--firmware=can0 --motor-id=ID` | Query firmware; the motor is stopped |
| `--update-firmware=can0 --motor-id=ID --model=RS-00` | Start a firmware update immediately |

Scan/version queries can stop motors. Firmware update is a write operation,
not a diagnostic check. See the [user guide](user-guide.md#update-firmware)
before using it.
