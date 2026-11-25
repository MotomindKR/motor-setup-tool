# User guide

[Download and quick start](../README.md) · [MuJoCo exports](simulation.md)

**Jump to:** [Connection](#connect-a-motor) · [Calibration](#run-calibration) ·
[Results](#compare-the-result) · [Test and jog](#monitor-and-jog-a-motor) ·
[Firmware](#update-firmware) · [Troubleshooting](#troubleshooting)

Choose your hardware from the **Workspace** dropdown in the sidebar. With
**RobStride** selected, the sidebar lists **Calibrate**, **Test**, **Setup**,
and **Files** for saved calibration runs. Choose **Dynamixel**
for XL330 setup and the MILLY teaching preview. Open **Camera** to check a
video feed. You can open **Settings** from any workspace.

## Connect a motor

Before scanning:

1. Secure the unloaded motor housing and clear the shaft.
2. Connect the correct power supply, CAN-H to CAN-H, and CAN-L to CAN-L.
3. Check grounding and termination against the adapter and motor manuals.
4. Close other motor-control applications.

| Adapter mode | Available on | Select in Connection |
|---|---|---|
| SocketCAN | Linux | A CAN interface such as `can0` |
| GS USB | Linux, macOS, Windows | A detected USB adapter |

### SocketCAN on Linux

Select the interface and click **Bring up CAN** to configure a down bus at 1 Mbps.
An active interface offers **Restart CAN**. The system authentication dialog
requires `iproute2`, `pkexec`, and a desktop authentication agent; the app does
not handle the password. If these are unavailable, configure an idle bus in a
terminal:

```sh
ip -details link show type can
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 1000000
```

Replace `can0` and the bitrate as needed. Run the app as your normal user.

### Direct GS USB adapters

On Linux, select **GS USB**. On macOS and Windows it is selected automatically.
Choose the USB adapter, then scan. A sole accessible adapter is selected for you.
Refreshing an unchanged adapter keeps the selected motor and its settings.
This mode uses the GS USB
protocol directly. On Linux, it temporarily detaches the `gs_usb` kernel
driver; when returning to SocketCAN, click **Bring up CAN** again.

Linux DEB/RPM installers set up USB access for the active desktop user.
Reconnect the adapter after installing, then refresh the adapter list.

For a source or unpacked build, install the rule from the repository once:

```sh
sudo install -m 0644 packaging/70-motomind-gsusb.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

The rule grants access to the active local desktop session; an SSH-only session
needs a separately configured USB access group.
If **USB access denied** remains, reconnect the adapter after loading the rule.
Refresh the list after reconnecting because its USB address may change.

### Scan

In **Connection**, choose the adapter and bus, then click **Scan motors**.
A single motor is selected automatically. If several are found, choose one.
The app reads its firmware to select the model and calibration preset.
Use an idle bus: scanning can stop responding motors. Each motor needs a unique
CAN ID. An unknown or unreadable firmware version blocks calibration.

## Run calibration

1. Review torque, speed, travel, and temperature under **Limits**. **Reset** restores
   the motor preset. **Advanced settings** contains duration, model, and save-folder options.
2. Check **Motor secured · limits reviewed** and press **Start calibration**.
3. Wait for recording, fitting, and validation to finish. The default recording
   contains 40 seconds of training and 20 seconds of separate validation.

**Motion preview** shows the requested speed and torque bursts. Completed runs
open in **Files**. To run another calibration, return to **Calibrate** and review
the limits again.

The motion suite uses speed steps, sweeps, torque bursts, and coast-down.
**Stop** cancels the job. Limits, communication errors, and motor faults also
stop acquisition. A disabled motor may coast, and a software stop cannot reach
a disconnected bus; keep a physical stop accessible.

## Compare the result

Start with **Validation**. These measurements were not used to choose the fitted
parameters. **Training** shows the recording used for fitting.

| View | What it shows |
|---|---|
| Motion | Measured position/velocity and MuJoCo before/after calibration |
| Residuals | Simulation minus measurement; zero means agreement |
| Torque | Commanded torque and motor-reported torque |

| Check | Meaning |
|---|---|
| Error cards | Fitted RMSE and change from the editable baseline |
| Fitted parameters | Estimated values, with full precision in saved files |
| Diagnostics | Rejection reasons and model limitations |

Use the graph controls to show or hide traces. A reference angle changes the
displayed position; fitting and residuals still use raw motor coordinates.
`report.json` stores the motor UUID and reference angle; accepted
`calibration.json` files do too.

Rejected fits remain available for inspection but have no accepted exports.
Check **Diagnostics** before recording again. A bare-motor fit does not predict
behavior with a robot load.

## Set zero or change the ID

Select the motor, then use **Test** or **Setup**:

- **Test → Set position as zero** makes the current shaft position the zero
  reference. The app stops the motor and checks that it is stationary first.
  Monitoring stops before the zero is written. Persistence across power cycles
  depends on the firmware.
- To show a chosen angle at the present shaft position, enter it under
  **Setup → Position reference → Display angle**, then select **Set current position**.
  The motor's firmware zero is set to 0; the app saves the displayed offset by
  the motor's eight-byte UUID. Live position and calibration reports carry this
  reference angle. The motor does not report this app offset to other software.
- Enter **New motor ID**, then **Change ID**. The app checks for an ID collision and verifies
  the same motor at its new address. It stays selected with the new ID; no rescan
  is needed. Your limits and position reference are kept.
- The top bar shows the connection or monitoring state. In **Test**, the live
  feedback badge shows **Enabled** or **Disabled**. **Disable motor** is available
  for the selected motor, except during firmware transfer or app installation.

### Persistent registers

Open **Setup**. The main area contains the register list and editor.

1. Search by name, symbol (such as `zero_sta`), or hex address.
2. Select a motor and register, then click **Read**.
3. Choose or enter a new value and click **Save to motor**. Confirm the change.
4. Power cycle and read again to verify persistence.

The save also commits other pending persistent settings. Access depends on the
model; write-only and undocumented settings are protected. See the
[register audit](registers.md) for the full permissions and persistence table.

## Monitor and jog a motor

1. Open **Test → Start monitoring**. The motor starts disabled. Live position,
   speed, torque, temperature, mode, and faults update; graphs retain 30 seconds.
   Stale or unavailable values show `--`.
2. Secure the housing, clear the shaft, choose a speed, and check
   **Motor secured · shaft clear**.
3. Click **Enable motor** and wait for the watchdog check. The same button changes to **Disable motor**.
4. Hold **Jog −** or **Jog +**. Release to command zero speed while keeping the
   motor enabled. Click **Disable motor** to turn torque off.

| Limit | Maximum |
|---|---|
| Speed | Lower of 1 rad/s and 10% of calibration speed limit |
| Torque | Lower of 10% rated torque and calibration torque limit |
| Travel | Configured calibration travel limit, measured from the enable position |

Enabling alone commands zero torque. After a jog, the controller brakes toward
zero speed without holding a fixed position. Jogging also stops on monitor
stop, tab/window/focus change, stale input, missing feedback, faults, or exceeded
limits. The Test view reports communication and limit errors. Stop monitoring
before changing motors or setup. Monitoring saves no recording.

Jogging slows near the configured travel boundary and stops outward motion
before the cutoff. Jog in the opposite direction to move back. There is no
separate one-revolution limit.

## Update firmware

The **Firmware update available** notice compares the selected motor against
the app's bundled, verified catalog. It works offline and does not track future
vendor releases or recommend downgrades.

1. Open **Setup → Firmware** and select **Download and verify**.
2. Compare the installed and target versions and confirm the model and ID.
3. Start the update. The app disables the motor before checking the bus and
   starting transfer. Keep motor power and USB connected until it finishes.

The app blocks cancellation and window closing during the write. Success
requires a matching version readback and the same motor identity. An interrupted
transfer may require the vendor's recovery tools. After a verified update, the
selected motor stays selected and its displayed firmware version refreshes,
including in the motor list. No rescan is needed. Your limits and position
reference are kept; review the limits again before starting calibration.

## Open, download, and delete recordings

In **Files**, select a saved run or use **Open** to choose a recording folder.
The report shows model, CAN ID and the eight-byte actuator UUID. New recordings
store the UUID with the raw samples in `session.json`. For older recordings,
refitting reads the UUID from `hardware.json` when available.

**Download** offers the entire run as a ZIP, individual training/validation CSVs,
and calibration JSON when present. ZIPs include the original identity metadata;
download filenames include model, CAN ID and UUID. The original CSV schema is
preserved. **Show folder** opens the originals. **Refit recording** replaces the
analysis artifacts using the original measured samples.

Each saved run has a menu with downloads and **Delete run**. Deletion requires
confirmation and permanently removes its calibration artifacts, bypassing the
OS Trash. Unrelated files in a custom output folder are preserved. Incomplete
runs also appear in the list and can be downloaded or deleted.

## Check a USB camera's focus

Open **Camera**, select a video device, and click **Start preview**. Allow
camera access if the operating system prompts. Starting the default camera
can reveal device names if the list has not been populated yet.
Select another device to switch the live feed. **Refresh cameras** rescans
the device list after plugging in a camera. The preview requests Full HD
(1920 × 1080) and uses a lower resolution if needed. The value below the video
shows the received frame size.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No CAN interface | USB connection, adapter driver, and whether Linux exposes a SocketCAN interface |
| Bus shown as Down or BUS-OFF | Stop other controllers, check power/wiring/termination/bitrate, then reconfigure the idle interface |
| Scan finds no motor | Motor power, matching bitrate, CAN wiring, and unique IDs |
| Unknown model or firmware | Read the installed version with the vendor's tool; unsupported version families cannot be calibrated |
| “No buffer space available” | Frames may not be draining from the transmit queue; investigate bus errors and acknowledgements before retrying |
| Watchdog preflight fails | Check the motor's firmware and close other CAN senders. A failed run saves `watchdog_preflight.json`; recent versions include a bounded CAN trace showing traffic during the quiet interval. Calibration requires the watchdog check to pass. |
| Another operation owns the bus | Finish or close the other app instance; do not delete its lock file |
| Fit rejected or residuals remain large | Read Diagnostics, verify a bare unloaded shaft and correct model, and inspect the measured motion |

Use **Settings → Appearance** to choose Light, Dark, or System.
