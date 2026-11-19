# Test the Dynamixel desktop app

Use the `feat/dynamixel-setup` checkout and Node.js 22.12 or newer on each
machine. The setup script creates a local Python environment, installs Electron
dependencies, and builds the locked Rust backend against MuJoCo 3.12.0. It
stores test window settings and Dynamixel backups under `.tools/desktop-test-user-data`.

## macOS

Run these commands in the checkout. The setup script uses the MuJoCo library
from the installed Motor Setup Tool if it already includes version 3.12.0.

```sh
bash scripts/test-desktop.sh --setup
bash scripts/test-desktop.sh --check
bash scripts/test-desktop.sh --run
```

## Ubuntu 22.04 from macOS

Start XQuartz on the Mac. If the feature branch is only local, copy the Git
bundle from the Mac checkout. Use your Ubuntu account and hostname in
`ubuntu_host`.

```sh
open -a XQuartz
ubuntu_host=user@ubuntu-host
ssh "$ubuntu_host" 'mkdir -p "$HOME/projects"'
scp .tools/motor-setup-tool-dxl-test.bundle "$ubuntu_host:projects/"
ssh -Y -o XAuthLocation=/opt/X11/bin/xauth "$ubuntu_host"
```

Run the following inside the Ubuntu session. `DISPLAY` should contain a
forwarded display such as `localhost:10.0`. Connect the U2D2 to Ubuntu when
testing the Ubuntu app.

```sh
cd ~/projects
git clone -b feat/dynamixel-setup motor-setup-tool-dxl-test.bundle motor-setup-tool-dxl-test
cd motor-setup-tool-dxl-test
sudo apt-get update
sudo apt-get install -y build-essential pkg-config ca-certificates curl python3-venv \
  xauth acl policykit-1 libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 libnotify4
printf 'DISPLAY=%s\n' "$DISPLAY"
bash scripts/test-desktop.sh --setup
bash scripts/test-desktop.sh --check
bash scripts/test-desktop.sh --run --ozone-platform=x11 --disable-gpu
```

The desktop Polkit agent on Ubuntu may display authorization prompts on the
Ubuntu console even while the app window is forwarded to the Mac. To verify
**Grant port access**, use a signed-in Ubuntu desktop session with its
authentication agent and test as the account that needs the port.

## Verify both hosts

1. Open **Dynamixel**, enable **Demo motors**, and connect. The table should
   show seven XL330 demo motors. Select ID 30 and click **Save zero**. Confirm
   a reading of 2048 pulses and 0° joint angle.
   Select ID 36 and use **Set Mode 5**. Confirm the mode changes from 3 to 5
   in the motor table.
   With only ID 36 selected, use **Set 1 Mbps**. Confirm the app reports
   verification and the connection speed reads `1000000`.
2. Disconnect and connect with demo off. Attach the U2D2 to the host running
   the app and power the motor. Pick its serial port and confirm that the
   model and ID appear. On Ubuntu, use **Grant port access** if access is
   denied. On macOS the typical port is `/dev/cu.usbserial-…`.
3. If testing a real EEPROM write, support the mechanism and follow the
   [Dynamixel setup guide](dynamixel.md). Restart motor power and confirm
   the saved settings at the same reference pose.
4. Open **Setup** and **Calibrate** and check that the existing RobStride
   workspace and CAN adapter controls are available.
