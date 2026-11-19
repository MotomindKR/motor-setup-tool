# Electron app

Electron hosts a React 19 frontend built with the
[Motomind UI design system](https://github.com/MotomindKR/design-guidelines).
A bundled Rust CLI process
handles CAN, motor control, firmware, calibration, and MuJoCo. The desktop app and standalone CLI share run files and CAN locks.

## Develop

From the repository root:

```sh
cargo build --locked --release
cd electron
npm ci
npm start
```

`npm start` builds the frontend with Vite before opening Electron. Run
`npm run check` for JavaScript, controller, IPC, and production build checks.
For browser interaction and responsive layout checks:

```sh
npx playwright install chromium
npm run test:ui
```

The browser tests inject a test-only bridge; they never access real hardware.
`npm run dev` serves the frontend on loopback. A normal browser shows desktop
launch instructions because only Electron supplies the motor bridge.

Development uses `target/release/motor-setup-tool`; set `MOTOMIND_BACKEND` to
select a different binary explicitly. Packaged apps always use their bundled
backend.
See the [developer guide](../docs/development.md) for MuJoCo setup and the
[user guide](../docs/user-guide.md#connect-a-motor) for CAN adapters. Saved runs
can be viewed without hardware.

## Desktop installers

```sh
cargo build --locked --release
cd electron
npm run package:installers
```

This produces DEB/RPM, DMG, or NSIS EXE installers in `dist-electron/`, each
with a `.sha256` file. Set `MUJOCO_DYNAMIC_LINK_DIR` if MuJoCo is outside
`.tools/mujoco/mujoco-3.12.0/lib`. See the [release guide](../packaging/README.md).

## Source

The renderer lives in `src/`. The controller owns backend requests and renews
the manual-control lease. The main process launches the Rust worker and closes
its input pipe when the user cancels. The worker performs motor cleanup before
exiting. The installer includes the renderer bundle and the production Node
dependencies.

See the [UI package provenance](vendor/README.md) for design system updates.
