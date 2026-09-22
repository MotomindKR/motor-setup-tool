# Protocol reference audit — September 22, 2026

The built-in profiles follow **communication type 1 (command) and type 2
(feedback)** in the official July 13, 2026 model manuals. These are protocol
encoding ranges, not product rated torque or no-load speed. Old SDK constants
are not used for built-in presets.

| Model | Speed range (rad/s) | Torque range (Nm) | Pinned source |
|---|---:|---:|---|
| RS00 | ±33 | ±14 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS00/RS00User%20Manual260713.pdf) |
| RS01 | ±44 | ±17 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS01/RS01User%20Manual260713.pdf) |
| RS02 | ±44 | ±17 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS02/RS02User%20Manual260713.pdf) |
| RS03 | ±20 | ±60 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS03/RS03User%20Manual260713.pdf) |
| RS04 | ±15 | ±120 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS04/RS04User%20Manual260713.pdf) |
| RS05 | ±50 | ±5.5 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS05/RS05User%20Manual260713.pdf) |
| RS06 | ±50 | ±36 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS06/RS06User%20Manual260713.pdf) |

All position ranges are ±4π rad. Type-1 torque occupies ID bits 8–23; payload
position, velocity, Kp and Kd are big-endian 16-bit values. Calibration keeps
Kp/Kd exactly zero. Feedback position/velocity/torque use the same documented
ranges; temperature is the unsigned 16-bit value divided by ten.

The official SDK previously used different RS00 (50/17), RS03 (50/60),
RS05 (33/17), and RS06 (20/60) speed/torque ranges. Saved GUI profiles that
exactly match a known old built-in preset migrate once to the manual values.
Custom values remain intact. The UI displays the selected ranges and provides
“Use latest documented ranges.” Saved sessions are never migrated or rescaled.
`preset_revision` records the preset generation; edited values are labeled
custom by comparison with the documented values, not by that field alone.

## Firmware and fault handling

- Version request: type 4, host in ID bits 8–15, selected motor in bits 0–7,
  payload `00 C4 00 00 00 00 00 00`. This is a stop-class command. The UI
  explicitly stops the selected motor first; it never enables it for this query.
- Version response: type 2, selected motor as source, host as destination,
  prefix `00 C4 56`, four version components in bytes 3–6. Version frames are
  excluded from motion feedback decoding.
- Hardware capture saves identity, firmware version (or null on timeout), and
  exact wire profile to `hardware.json`. A version timeout does not imply any
  particular firmware version; bus errors and actual motor faults still abort.
- Type 17 parameter-read replies with nonzero status in ID bits 16–23 are
  rejected, rather than interpreting their payload as a successful value.
- Type 21 carries little-endian 32-bit fault and warning fields. Any nonzero
  fault aborts the active operation; bit 1 is the driver-chip fault, included in
  the latest firmware notes. Warning-only reports are not treated as faults.
- Scan (type 0), enable (3), stop (4), zero (6, payload byte 0 = 1), and ID change
  (7, new ID in bits 16–23) match the manuals. Zero and ID changes stop first.
- Watchdog index 0x7028 uses 20,000 ticks/second in the manual. The app writes
  2,000 ticks and verifies actual expiry before recording. It does not save
  parameters to flash, factory-reset, or update firmware.

Latest public firmware release checked: [V26.05.19](https://github.com/RobStride/Product_Information/releases/tag/V26.05.19),
RS00 binary `rs00-0.0.3.32.bin`. A manual revision is not an installed firmware
version. Firmware notes also describe initialization and cogging calibration;
these change the motor's behavior and are not silently enabled by this app.

## Live motor identification after bus restart

After restarting can0 at 1 Mbps, motor ID 7 returned UUID
`477830222431310f` and version response `00 c4 56 00 05 00 0e 07`,
i.e. **0.5.0.14**. Both queries received replies with zero CAN error frames.
The user corrected the motor identification to **RS-05**. The official
V26.05.19 release lists `rs05_0.5.0.14.bin`: this matches the reported firmware.
The native Rust version-query implementation independently returned the same
version. Evidence: `diagnostics/firmware_after_restart.json` and
`diagnostics/latest_firmware_release.json`.

The recording was acquired using an RS00 profile for an RS05 motor.
Acquisition now compares selected model with recognized official firmware
families (0.N.x.y, N=0…6), and rejects a mismatch before setting mode/watchdog
or enabling. Unknown version formats remain unknown rather than being assigned
a model. No firmware was flashed, no factory reset was performed, and no
calibration motion was commanded by this investigation.

## Existing recording discrepancy

The original `runs/1790063752063-88592` used RS00 33 rad/s and 14 Nm
ranges for the RS05 motor. Its position changes are approximately 1.515 times
the integral of reported velocity, explained by 50/33. The corrected copy
`runs/1790063752063-88592-rs05-manual` applies velocity ×50/33 and both commanded
and reported torque ×5.5/14. Experiment limits are reinterpreted to preserve
the recorded encoded bounds. Provenance is saved in `reprocessing.json`; the
original session is untouched. Firmware was queried after the original run.
The corrected candidate still fails held-out validation, so it is not promoted.
An earlier SDK-profile experiment remains a rejected historical diagnostic.

The app retains a position/velocity consistency check (200 ms integration
windows, 10% tolerance). It runs during capture once at least 200 samples and
0.3 rad net travel exist, and again before fitting both complete traces.
A mismatch stops recording and preserves the partial trace; it does not
select an older profile, change firmware, infer torque scaling, or relax fit
acceptance. This detects incompatible data, not its underlying firmware or
configuration cause. Correcting units alone has not produced an accepted calibration for this recording.
