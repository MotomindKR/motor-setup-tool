# User guide

[Download and quick start](../README.md) · [MuJoCo exports](simulation.md)

## Connect a motor

Use an unloaded motor with its housing secured and shaft clear. Connect a power
supply appropriate for the motor, CAN-H to CAN-H, and CAN-L to CAN-L. Follow the
adapter and motor documentation for grounding and CAN termination. Close other
motor-control applications before operating this tool.

The app uses Linux SocketCAN. The adapter must have a working kernel driver and
appear as a CAN interface, such as `can0`. Select a down interface and click
**CAN up** to configure **1 Mbps**. Linux opens its administrator authentication
dialog; the app never handles your password. An interface that is already up
offers **Restart CAN** instead. Setup is disabled while this app is controlling a motor.

The button requires the host's `iproute2`, `pkexec`, and desktop authentication
agent. If these are unavailable, configure an idle bus in a terminal:

```sh
ip -details link show type can
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 1000000
```

Replace `can0` with your adapter's interface and use the bitrate configured on
your motor. Run the app as your normal user.

In **Connection**, choose the bus, click **Scan**, then choose the discovered
motor. The app reads its firmware to select the model and calibration preset.
Scan can stop responding motors, so use it on an idle bus. Each motor needs a
unique CAN ID. An unknown or unreadable firmware version blocks calibration.

## Run calibration

1. Select **Calibrate**. Review maximum torque, speed cutoff, requested speed, and travel.
2. Open **Motion preview** to see the requested speed and torque bursts. These
   are test inputs, not predictions of the motor's response.
3. If needed, adjust limits and recording duration under **Advanced**. **Restore
   motor preset** restores the selected model's settings.
4. Check **Motor secured · limits reviewed** and press **Start calibration**.
5. Wait for recording, fitting, and validation to finish. The default recording
   contains 40 seconds of training and 20 seconds of separate validation.

The suite combines speed steps, sine sweeps, multisine motion, torque bursts,
and coast-down. The app stops acquisition if a configured limit, communication
check, or motor fault check fails. **Stop** stays visible while the job runs.
Disabling a motor can let it coast; a software stop cannot reach a disconnected
bus. Keep a physical stop accessible.

## Compare the result

Start with **Validation**. These measurements were not used to choose the fitted
parameters. **Training** shows the recording used for fitting.

| View | What it shows |
|---|---|
| Motion | Measured position/velocity and MuJoCo before/after calibration |
| Residuals | Simulation minus measurement; zero means agreement |
| Torque | Commanded torque and motor-reported torque |

Each graph has a legend. Hover an entry to highlight its trace; click it to
hide or restore that trace in the graph. The controls above the graphs select
which measured/before/after series are available across the comparison plots.
Zoom or drag a plot to inspect a section of the recording.

The error cards show the fitted model's RMSE and the change from the baseline.
The baseline is an editable starting model, not manufacturer inertia/friction
measurements. **Fitted parameters** shows the resulting values; **Diagnostics**
explains rejection reasons and model limitations. Displayed values use compact
precision; saved files retain full precision.

A rejected fit is saved for inspection but does not produce accepted calibration
exports. Read the diagnostics, check the setup and limits, and record again if
needed. A good bare-motor result does not establish behavior under a robot load.

## Set zero or change the ID

Select the motor. Zero setting is in **Test**; ID changes are in **Setup**:

- **Test → Set current position as zero** makes the current shaft position the zero
  reference. The app stops the motor and checks that it is stationary first.
  Monitoring stops before the zero is written. Persistence across power cycles
  depends on the firmware.
- Enter **New ID**, then **Apply**. The app checks for an ID collision and verifies
  the same motor at its new address.
- The top bar shows **Connected · Enabled** or **Connected · Disabled**.
  **Disable motor** is available only while the selected motor is enabled.

## Monitor and jog a motor

Open **Test** and choose **Start monitoring**. The motor is disabled first;
position, speed, torque, temperature, mode, and fault bits update live. Graphs
show the last 30 seconds. Unavailable or stale live values display `--`.

To jog, secure the motor, clear the shaft, select a speed, and check
**Motor secured · shaft clear**. Choose **Enable motor**, wait for the watchdog
check, then hold **Jog −** or **Jog +**. The button keeps the jog active if the
pointer drifts outside it.
Releasing the button commands zero speed and keeps the motor enabled, so you
can jog again immediately. **Disable motor** in the top-right bar turns torque
off. Enabling alone applies zero torque; after a jog, the controller brakes
toward zero speed without holding a fixed position.

Jog speed is capped at 1 rad/s or 10% of the model's calibration speed limit,
whichever is lower. Torque is capped at 10% of rated torque or the calibration
limit, whichever is lower. Travel is limited to ±one output revolution from
each enable position, or the smaller calibration travel limit. These limits
are intended for a secured bare motor.

**Disable motor** at the top right, **Stop monitoring**, switching tabs, closing
the window,
loss of focus, stale UI input, missing feedback, faults, and exceeded limits
stop jogging. The status bar shows why jogging stopped, and communication or
limit errors remain visible in the Test view. The firmware watchdog must pass
before jogging is permitted.
Motor selection and setup operations are locked while monitoring; stop
monitoring to change them. Monitoring does not create a calibration recording.

## Update firmware

After scanning, **Firmware update available** appears beside the selected motor
when its version is older than the verified release in the app’s catalog. Click
the notice to open the updater. This comparison works offline; it does not poll
for future vendor releases or recommend downgrading newer firmware.

Open **Setup → Firmware update** and choose **Download and verify**.
Review the installed and target versions, then press the update button for the
selected model and ID. The catalog's release is shown in the UI; it is bundled
with the app rather than automatically following the vendor's newest release.

Keep motor power and USB connected until the update finishes. Cancellation and
window closing are disabled while writing firmware. Success requires a matching
version readback and unchanged motor identity. The updater needs a responsive
motor; recovery from an interrupted transfer may require the vendor's tools.

## Open and refit recordings

Recordings are saved automatically. In **Files**, enter a saved run folder and
choose **Open** to view it or **Refit** to rerun fitting without moving hardware.
Refit replaces analysis artifacts in that folder; copy the folder first if you
want to preserve the earlier result.

Default locations:

| Data | Location |
|---|---|
| Recordings and results | `~/.local/share/motomind-motor-calib/runs/` |
| Downloaded firmware | `~/.cache/motomind-motor-calib/firmware/` |

`XDG_DATA_HOME` and `XDG_CACHE_HOME` override these base directories. Use
**Copy folder path** for the current run. See [Simulation and exports](simulation.md)
for the files to use in your robot model.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No CAN interface | USB connection, adapter driver, and whether Linux exposes a SocketCAN interface |
| Bus shown as Down or BUS-OFF | Stop other controllers, check power/wiring/termination/bitrate, then reconfigure the idle interface |
| Scan finds no motor | Motor power, matching bitrate, CAN wiring, and unique IDs |
| Unknown model or firmware | Read the installed version with the vendor's tool; unsupported version families cannot be calibrated |
| “No buffer space available” | Frames may not be draining from the transmit queue; investigate bus errors and acknowledgements before retrying |
| Watchdog preflight fails | Check the firmware and communication state; calibration requires the watchdog check to pass |
| Another operation owns the bus | Finish or close the other app instance; do not delete its lock file |
| Fit rejected or residuals remain large | Read Diagnostics, verify a bare unloaded shaft and correct model, and inspect the measured motion |
| AppImage reports a FUSE error | Launch with `APPIMAGE_EXTRACT_AND_RUN=1` |

The interface follows system light/dark appearance. There is no separate theme
switch in the app.
