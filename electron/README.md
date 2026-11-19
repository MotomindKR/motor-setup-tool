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

## Operation details

| View | Purpose |
|---|---|
| Calibrate | Review limits and motion preview, record a run, fit, and inspect results |
| Test | Monitor feedback and use bounded hold-to-jog controls |
| Setup | Set zero/reference angle, change ID, search and edit persistent registers in the main area, update firmware |
| Files | Open saved runs, compare traces, download files, refit, or permanently delete |

Navigation uses Motomind's Sidebar, with an icon collapse mode and a mobile
Sheet opened by the header toggle. Connection settings sit above each motor
workspace and collapse after selecting a motor. A single scanned motor is selected
automatically. Calibration shows limits and one Start action; advanced settings
and motion preview are collapsed. Results replace the form. Settings is at the
bottom of the rail.

## Frontend source

`src/App.jsx` owns the shell and appearance. `src/pages/` contains the four
workspaces, `src/components/` shared connection/settings panels, and
`src/Chart.jsx` the measured-data plots. `src/controller.mjs` owns bridge calls,
operation state, preview sequencing, and the manual intent lease independently
of React rendering. Hardware writes use explicit confirmation dialogs.

The versioned UI package in `vendor/` provides the components, brand mark, and
light/dark tokens. Sidebar, Breadcrumb, Card, Field, NumberField, Select,
Checkbox, Slider, Accordion, Collapsible, ToggleGroup, Empty, Item,
Table, Progress, Alert, Dialog, and chart components come from that package.
See [vendor/README.md](vendor/README.md) for its provenance
and update process. Product CSS only supplies layout; Pretendard is bundled
locally. Builds require no GitHub Packages login. Desktop packaging builds and
copies `ui-dist/`, including fonts, so installed apps need no Node packages or
network connection for their interface.

Only one backend operation runs at a time. Stop signals the CLI, whose worker
disables the motor before exit. Opening the app or a recording sends no motor
command. Firmware transfer finishes before the window closes.

**Settings** shows the version and appearance. The packaged app checks for
updates in the background and marks the Settings button when one is available.
Choose **Install update** when the motor is idle. For macOS builds with ad-hoc
signing, install the DMG from the release page.
