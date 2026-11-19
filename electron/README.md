# Electron app

The desktop app uses React and the [Motomind UI components](https://github.com/MotomindKR/design-guidelines). The Rust worker handles CAN traffic and motor timing. Cancelling a job closes the worker’s input pipe so it can stop the motor before exiting.

## Develop

See the [developer guide](../docs/development.md#build-and-run) for setup, launch commands, and tests. For frontend development, `npm run dev` starts Vite on loopback. The motor bridge is available in Electron and simulated by the browser tests.

## Desktop installers

Build on the target operating system using the [release guide](../packaging/README.md#build-locally).

## Source

The renderer lives in [src/](src/), the Rust process bridge in [backend.js](backend.js), and the main process in [main.js](main.js). See [UI package provenance](vendor/README.md) when updating the design system.
