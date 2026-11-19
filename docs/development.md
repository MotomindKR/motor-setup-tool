# Developer guide

[User documentation](../README.md) · [Identification](identification.md) ·
[Protocol](protocol.md) · [Release packaging](../packaging/README.md)

## Build and run

Install Node.js 22 or newer, a C compiler/linker, and the [MuJoCo SDK](../packaging/README.md#build-locally).

```sh
./scripts/setup.sh
cd electron
npm ci
npm start
```

`setup.sh` installs a workspace-local Rust toolchain if needed and builds the
release backend. `npm start` builds the frontend and opens Electron. Development
uses `target/release/motor-setup-tool`; `MOTOMIND_BACKEND` explicitly overrides
that path. Packaged apps always use the bundled backend.

For terminal use, `./scripts/run.sh --help` runs the same backend. Running it
without arguments prints CLI help. To inspect recordings without hardware,
open Electron and select a saved folder in **Files**.

Data, cache, and CAN lock paths retain their v0.1.0 locations so desktop and CLI
sessions contend for the same bus ownership. See the [CLI guide](cli.md).

## Checks

With Cargo on `PATH`:

```sh
rustup component add rustfmt clippy
./scripts/check.sh
cd electron
npm run check
npx playwright install chromium
npm run test:ui
```

For the workspace-local toolchain, first set:

```sh
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
```

CI runs the same [backend and frontend checks](../.github/workflows/tests.yml) on pull requests to `main`.

For the Linux test environment locally:

```sh
docker build -f packaging/Dockerfile -t motomind-tests .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/work/.tools/ci-cargo -v "$PWD:/work" \
  motomind-tests bash scripts/check-ci.sh
```

## Code map

| Module | Responsibility |
|---|---|
| `electron/src/` | Motomind React frontend, charts, and controller |
| `electron/main.js`, `preload.js`, `backend.js` | Desktop window, IPC, and Rust process bridge |
| `electron/recordings.js` | Recording metadata, downloads, and permanent deletion |
| `cli.rs`, `can_admin.rs` | CLI, signals, and authenticated CAN setup |
| `manual.rs` | Jog control, UI intent lease, and motor limits |
| `hardware.rs`, `protocol.rs`, `firmware.rs`, `registers.rs` | CAN transport, motor protocol, OTA, and setup parameters |
| `types.rs`, `experiment.rs` | Profiles, limits, and measurement plans |
| `fit.rs`, `engine.rs`, `pipeline.rs` | Fitting, MuJoCo replay, validation, and exports |
| `bridge.rs`, `paths.rs` | Artifact I/O and stable data directories |

The Rust worker owns motor timing and the watchdog. Electron renews a 250 ms
intent lease during manual control; focus loss, stale intent, or communication
failure disables the motor. Opening a view never enables motion.

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

Run `npm run test:ui` in `electron/` for screenshots and interaction checks in
light/dark themes and at narrow widths. Native window chrome and OS file dialogs
also need an Electron smoke test. Set `MOTOMIND_SMOKE_PATH` to capture the
packaged startup window and a JSON runtime summary. The installed updater tests
use this hook to verify the restarted app.

To inspect real data manually, open a saved recording through **Files**. Use a
copy when testing **Refit recording**, which replaces analysis artifacts.
Appearance follows Electron's native system theme setting. Fonts and branding
are bundled; see [asset provenance](../assets/README.md).
