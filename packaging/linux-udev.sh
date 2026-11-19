# Pick up installed/removed rules without reconfiguring connected adapters.
# udev may be absent or not running when installing into a container or chroot.
if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules || true
fi
