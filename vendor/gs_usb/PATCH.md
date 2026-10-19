# Local gs_usb patch

Based on `gs_usb` 0.1.1 (MIT), https://github.com/maksimdrachov/gs_usb_rs.

`GsUsb::start` in 0.1.1 resets the USB device after callers configure CAN bit timing. This patch exposes `claim()`, removes that USB reset, and lets the caller claim the interface, reset the CAN channel, set bit timing, and start the channel in that order. It also avoids claiming an interface twice when `start()` is called again on the same handle.
