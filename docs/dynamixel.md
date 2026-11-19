# Dynamixel setup

Open **Dynamixel** in Motor Setup Tool to configure XL330-M288-T and
XL330-M077-T motors. Connect a U2D2 adapter to the TTL bus and power the
motors separately. Close other programs using the same serial port.

1. Choose or type the serial port. The app searches at 1,000,000 bps by
   default and tries the factory speed of 57,600 bps if no supported motor
   responds. If you select 57,600 bps, the app searches there first. Typical
   ports are `/dev/ttyACM0` or `/dev/ttyACM1` on
   Ubuntu, `COM3` on Windows, and `/dev/cu.usbserial-…` on macOS.
2. On Linux, use **Grant port access** if the port is inaccessible. Approve
   the system prompt. The app grants your user read/write access to the
   selected device node. Unplugging the adapter removes that grant. The app
   uses `pkexec` and `setfacl`, supplied by polkit and acl.
3. Click **Connect** to discover motors and select them in the **Motors**
   table. **Baud rate (bps)** shows each motor's stored speed. **Scan bus**
   refreshes the list at the session's active speed.
   Select **Demo motors** before connecting to practice without hardware.

Support the mechanism before using **Torque off**. To save direction,
zero, mode, ID, or baud, the motor must report torque off, no hardware error, and
Status Return Level 2.

- **Set 1 Mbps** saves 1,000,000 bps to the selected motor. Connect only that
  motor to the U2D2, using its current speed. After the write, the app switches
  to 1,000,000 bps and verifies the stored value at the same ID. If verification
  fails after writing, reconnect and scan at 1,000,000 bps and at the old speed
  before attempting another write. The backup records elapsed milliseconds for
  the bus scan, port speed changes, EEPROM write, and readback.
- **Set Mode 5** saves Current-based Position Control Mode on selected motors
  that report a different mode. The app reads back the mode and updates the
  table. Mode changes reset control settings such as gains and profiles. The
  motor's Min/Max Position Limits do not apply in Mode 5.
- **Direction** changes the direction bit in Drive Mode. Set direction
  before calibrating zero.
- **Save zero** reads the selected motors, checks that the reference pose
  stays steady, and saves the offset. Hold the reference pose while the app
  verifies the result. The target is 2048 pulses, corresponding to 0° of
  joint angle. The table shows raw motor angle and joint angle separately.
  Zero is supported in position modes 3, 4, and 5.
- **ID** applies to a single selected motor. The new ID must be available
  and between 0 and 252. If several motors share a factory ID, connect one
  motor at a time for ID assignment.

After saving, keep the mechanism in the same reference pose, power-cycle
the motors, and reconnect. Check the IDs, position, direction, and mode again.
Check for one-revolution jumps around the actual range of motion.

The app records a JSON backup before each EEPROM write. Open it with
**Open backup folder** or make a snapshot with **Export settings**.
**Restore zero and direction** accepts DXL Studio and Motor Setup Tool
backups that match the selected IDs, models, operating modes, and demo
setting. To restore a previous ID, use **Save ID** at the motor's current
address. After an uncertain write, reconnect and scan to verify what was
applied before attempting another write.

The configuration service and Protocol 2.0 transport come from
[Motomind DXL Studio](https://github.com/MotomindKR/motomind_dxl_studio/tree/d306050).
