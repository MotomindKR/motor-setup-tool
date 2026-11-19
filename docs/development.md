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

## Desktop translations

Use `useTranslation()` in React and `t` from `electron/i18n.js` in the Electron
main process. English UI text is the message key. Add its translation to
`electron/locales/ko.json` and use named placeholders for values. Rust progress
events carry their parameters so the renderer can translate them while a job runs.
The Python serial worker receives the language with each request and loads
`dxl/dxl_settings/ko.json` for Korean messages.

## Dynamixel development

From the repository root, set up the serial worker's Python environment before
launching Electron or running the tests that exercise the worker.

```sh
python3 -m venv .tools/dxl-venv
. .tools/dxl-venv/bin/activate
python -m pip install -r dxl/requirements.txt pytest
export MOTOMIND_DXL_PYTHON="$(command -v python)"
python -m pytest -q -o pythonpath=dxl dxl/tests
npm --prefix electron start
```

On Windows, use `python -m venv` and set `MOTOMIND_DXL_PYTHON` to the absolute
path of `.tools\dxl-venv\Scripts\python.exe`.

### U2D2 hardware checks

1. Power an XL330 and connect the U2D2 to the machine running the app. Confirm
   discovery at the motor's stored baud rate and verify the model, ID, and mode.
   On Linux, check **Grant port access** if the port is inaccessible.
2. Support the mechanism. With a single motor connected, verify **Torque off**,
   **Set Mode 5**, and **Set 1 Mbps** where applicable. Keep the reference pose
   fixed during **Save zero** and confirm 2048 pulses and a 0° joint angle.
3. Power-cycle the motor and reconnect to check the saved settings. Follow the
   [operator guide](dynamixel.md) when recovering from a write with an uncertain result.
4. Check that the existing CAN adapter controls are available in **Setup** and
   that the **Calibrate** workspace opens.

The reverse offset response was observed on an XL330 with firmware 53 in Mode 5.
The [ROBOTIS Drive Mode](https://emanual.robotis.com/docs/en/dxl/x/xl330-m288/#drive-mode10)
and [Homing Offset](https://emanual.robotis.com/docs/en/dxl/x/xl330-m288/#homing-offset20)
sections describe the relevant registers. Verify the resulting position on the
connected motor for its model, firmware, and mode.

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
