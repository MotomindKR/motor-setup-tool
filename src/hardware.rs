//! SocketCAN, serial SLCAN, and direct GS-USB transport for the RobStride protocol.
use crate::{
    bridge,
    encoder::EncoderTracker,
    protocol::{self, Feedback, WireFrame},
    types::*,
};
use anyhow::{Context, Result, ensure};
use gs_usb::{CAN_EFF_FLAG, DeviceCapability, GS_CAN_MODE_NORMAL, GsUsb, GsUsbError, GsUsbFrame};
use serde::Serialize;
use sha2::{Digest, Sha256};
use slcanio::{
    AdapterProfile, Bitrate, CanId as SerialCanId, blocking::CanSocket as SerialCanSocket,
};
#[cfg(target_os = "linux")]
use socketcan::{CanFrame, CanSocket, EmbeddedFrame, ExtendedId, Id, Socket, SocketOptions};
use std::{
    path::Path,
    sync::Mutex,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub struct Bus {
    _lock: std::fs::File,
    socket: BusSocket,
    config: Config,
}

#[derive(Serialize)]
pub(crate) struct QuietCanFrame {
    elapsed_ms: u128,
    id: String,
    data: String,
}

pub(crate) struct WatchdogPreflight {
    pub(crate) feedback: Feedback,
    pub(crate) passive_reports: usize,
    pub(crate) last_passive_report_ms: Option<u128>,
    pub(crate) used_passive_report: bool,
    pub(crate) addressed_frames: usize,
    pub(crate) quiet_frames: Vec<QuietCanFrame>,
    pub(crate) quiet_frames_omitted: usize,
    pub(crate) gsusb_tx_echoes: Option<u64>,
}
enum BusSocket {
    #[cfg(target_os = "linux")]
    SocketCan(CanSocket),
    Slcan(Mutex<Option<SerialCanSocket>>),
    GsUsb(Mutex<UsbSocket>),
}

struct UsbSocket {
    device: Option<GsUsb>,
    tx_echoes: u64,
    #[cfg(target_os = "linux")]
    bus: u8,
    #[cfg(target_os = "linux")]
    address: u8,
    #[cfg(target_os = "linux")]
    restore_kernel: bool,
}
impl UsbSocket {
    fn new(device: GsUsb, bus: u8, address: u8) -> Self {
        #[cfg(target_os = "linux")]
        let restore_kernel = rusb::devices().ok().is_some_and(|devices| {
            devices.iter().any(|item| {
                item.bus_number() == bus
                    && item.address() == address
                    && item
                        .open()
                        .ok()
                        .is_some_and(|handle| handle.kernel_driver_active(0).unwrap_or(false))
            })
        });
        #[cfg(not(target_os = "linux"))]
        let _ = (bus, address);
        Self {
            device: Some(device),
            tx_echoes: 0,
            #[cfg(target_os = "linux")]
            bus,
            #[cfg(target_os = "linux")]
            address,
            #[cfg(target_os = "linux")]
            restore_kernel,
        }
    }
    fn device(&mut self) -> &mut GsUsb {
        self.device.as_mut().expect("GS-USB device already closed")
    }
    fn tx_echoes(&self) -> u64 {
        self.tx_echoes
    }
}
impl Drop for UsbSocket {
    fn drop(&mut self) {
        // gs_usb stops the adapter on drop. Release its USB handle before reattaching Linux.
        drop(self.device.take());
        #[cfg(target_os = "linux")]
        if self.restore_kernel
            && let Ok(devices) = rusb::devices()
        {
            for item in devices.iter() {
                if item.bus_number() == self.bus
                    && item.address() == self.address
                    && let Ok(handle) = item.open()
                    && !handle.kernel_driver_active(0).unwrap_or(false)
                {
                    let _ = handle.attach_kernel_driver(0);
                }
            }
        }
    }
}

#[derive(Serialize)]
pub struct UsbAdapter {
    pub bus: u8,
    pub address: u8,
    pub vendor_id: u16,
    pub product_id: u16,
    pub accessible: bool,
}

pub fn available_usb_adapters() -> Result<Vec<UsbAdapter>> {
    let mut adapters = Vec::new();
    for device in rusb::devices()?.iter() {
        let Ok(desc) = device.device_descriptor() else {
            continue;
        };
        let id = (desc.vendor_id(), desc.product_id());
        if matches!(
            id,
            (0x1d50, 0x606f) | (0x1209, 0x2323) | (0x1cd2, 0x606f) | (0x16d0, 0x10b8)
        ) {
            adapters.push(UsbAdapter {
                bus: device.bus_number(),
                address: device.address(),
                vendor_id: id.0,
                product_id: id.1,
                accessible: device.open().is_ok(),
            });
        }
    }
    adapters.sort_by_key(|adapter| (adapter.bus, adapter.address));
    Ok(adapters)
}

fn gsusb_address(interface: &str) -> Result<Option<(u8, u8)>> {
    let Some(rest) = interface.strip_prefix("gsusb:") else {
        return Ok(None);
    };
    let (bus, address) = rest
        .split_once(':')
        .context("GS-USB address must be gsusb:bus:device")?;
    let bus = bus.parse::<u8>().context("Invalid GS-USB bus number")?;
    let address = address
        .parse::<u8>()
        .context("Invalid GS-USB device address")?;
    ensure!(bus > 0 && address > 0, "Invalid GS-USB device address");
    Ok(Some((bus, address)))
}

fn gsusb_wire_frame(frame: &GsUsbFrame) -> Result<Option<WireFrame>> {
    if frame.is_error_frame() {
        anyhow::bail!("GS-USB CAN bus error; check wiring, termination, motor power and bitrate");
    }
    if frame.is_rx_frame()
        && frame.is_extended_id()
        && !frame.is_remote_frame()
        && !frame.is_fd()
        && frame.data_length() == 8
    {
        let mut data = [0; 8];
        data.copy_from_slice(frame.data());
        Ok(Some(WireFrame {
            id: frame.arbitration_id(),
            data,
        }))
    } else {
        Ok(None)
    }
}

fn gsusb_timing(cap: &DeviceCapability) -> Result<(u32, u32, u32, u32, u32)> {
    const BITRATE: u64 = 1_000_000;
    ensure!(
        cap.brp_inc > 0,
        "GS-USB adapter reports invalid bitrate limits"
    );
    let max_brp = cap.brp_max.min(cap.fclk_can / BITRATE as u32);
    for brp in (cap.brp_min..=max_brp).step_by(cap.brp_inc as usize) {
        let clock = u64::from(cap.fclk_can);
        let divisor = BITRATE * u64::from(brp);
        if divisor == 0 || clock % divisor != 0 {
            continue;
        }
        let total = clock / divisor;
        if total < 4 {
            continue;
        }
        let tseg1 = (total * 3 / 4).saturating_sub(1) as u32;
        let tseg2 = (total - 1) as u32 - tseg1;
        if !(cap.tseg1_min..=cap.tseg1_max).contains(&tseg1)
            || !(cap.tseg2_min..=cap.tseg2_max).contains(&tseg2)
            || cap.sjw_max == 0
        {
            continue;
        }
        let sjw = (tseg2 / 2).max(1).min(tseg2).min(cap.sjw_max);
        let prop_seg = tseg1 / 2;
        let phase_seg1 = tseg1 - prop_seg;
        return Ok((prop_seg, phase_seg1, tseg2, sjw, brp));
    }
    anyhow::bail!(
        "GS-USB adapter cannot represent 1 Mbps with its reported CAN clock and timing limits"
    )
}

struct SlcanConnection {
    port: String,
    baud: u32,
    profile: AdapterProfile,
}
impl SlcanConnection {
    fn parse(interface: &str) -> Result<Option<Self>> {
        let Some(rest) = interface.strip_prefix("slcan:") else {
            return Ok(None);
        };
        let mut parts = rest.splitn(3, ':');
        let profile = match parts.next() {
            Some("lawicel") => AdapterProfile::LawicelClassic,
            Some("canable") => AdapterProfile::CanableFd,
            _ => anyhow::bail!("SLCAN profile must be lawicel or canable"),
        };
        let baud = parts
            .next()
            .context("SLCAN UART speed is missing")?
            .parse::<u32>()?;
        ensure!(
            (9_600..=3_000_000).contains(&baud),
            "Invalid SLCAN UART speed"
        );
        let port = parts.next().context("SLCAN serial port is missing")?;
        #[cfg(unix)]
        ensure!(
            port.starts_with("/dev/") && port.len() <= 256 && !port.contains('\0'),
            "SLCAN port must be a device under /dev"
        );
        #[cfg(windows)]
        ensure!(
            port.len() <= 64
                && port
                    .to_ascii_uppercase()
                    .strip_prefix("COM")
                    .is_some_and(|number| number.parse::<u16>().is_ok_and(|value| value > 0)),
            "SLCAN port must be a COM port"
        );
        Ok(Some(Self {
            port: port.into(),
            baud,
            profile,
        }))
    }
}
pub(crate) fn lock_interface(interface: &str) -> Result<std::fs::File> {
    ensure!(
        !interface.is_empty()
            && interface.len() < 16
            && interface
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
            && interface != "."
            && interface != "..",
        "Invalid CAN interface name"
    );
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(crate::paths::lock_dir()?.join(format!("{interface}.lock")))?;
    lock.try_lock()
        .context("Another motor operation owns this CAN interface")?;
    Ok(lock)
}
impl Bus {
    fn gsusb_tx_echoes(&self) -> Option<u64> {
        if let BusSocket::GsUsb(device) = &self.socket {
            Some(
                device
                    .lock()
                    .expect("GS-USB device lock poisoned")
                    .tx_echoes(),
            )
        } else {
            None
        }
    }

    pub fn open(config: &Config) -> Result<Self> {
        let (lock, socket) = if let Some((usb_bus, usb_address)) = gsusb_address(&config.interface)?
        {
            let lock = lock_interface(&format!("gsusb-{usb_bus:03}-{usb_address:03}"))?;
            let device = GsUsb::find(usb_bus, usb_address)
                .context("Open GS-USB adapter; check USB device access")?
                .context(
                    "GS-USB adapter was unplugged or its USB address changed; refresh adapters",
                )?;
            let mut device = UsbSocket::new(device, usb_bus, usb_address);
            device.device().claim().context("Claim GS-USB interface")?;
            device
                .device()
                .stop()
                .context("Reset GS-USB CAN channel before timing")?;
            let capability = device
                .device()
                .device_capability()
                .context("Read GS-USB timing limits")?;
            let (prop_seg, phase_seg1, phase_seg2, sjw, brp) = gsusb_timing(&capability)?;
            device
                .device()
                .set_timing(prop_seg, phase_seg1, phase_seg2, sjw, brp)
                .context("Set GS-USB bitrate to 1 Mbps")?;
            device.device().start(GS_CAN_MODE_NORMAL).context(
                "Start GS-USB adapter; check USB access and whether another application owns it",
            )?;
            (lock, BusSocket::GsUsb(Mutex::new(device)))
        } else if let Some(serial) = SlcanConnection::parse(&config.interface)? {
            #[cfg(unix)]
            let port = std::fs::canonicalize(&serial.port)
                .with_context(|| format!("SLCAN serial port {} is unavailable", serial.port))?;
            #[cfg(windows)]
            let port = std::path::PathBuf::from(serial.port.to_ascii_uppercase());
            #[cfg(unix)]
            ensure!(
                port.starts_with("/dev/"),
                "SLCAN port must resolve under /dev"
            );
            let key = Sha256::digest(port.to_string_lossy().as_bytes());
            let lock = lock_interface(&format!(
                "slcan-{:02x}{:02x}{:02x}{:02x}",
                key[0], key[1], key[2], key[3]
            ))?;
            let socket = SerialCanSocket::builder(serial.port.clone(), serial.baud)
                .adapter(serial.profile)
                .nominal_bitrate(Bitrate::Mbps1)
                .timeout(Duration::from_millis(2))
                .connect()
                .with_context(|| format!("Open SLCAN adapter on {} at {} baud; check port access, adapter profile and CAN wiring", serial.port, serial.baud))?;
            (lock, BusSocket::Slcan(Mutex::new(Some(socket))))
        } else {
            #[cfg(not(target_os = "linux"))]
            anyhow::bail!("SocketCAN is only available on Linux; select an SLCAN serial port");
            #[cfg(target_os = "linux")]
            {
                let lock = lock_interface(&config.interface)?;
                let socket = CanSocket::open(&config.interface).context(
                    "Open SocketCAN interface (configure bitrate and bring it up first)",
                )?;
                socket.set_nonblocking(true)?;
                // Receive bus error frames so faults stop scans before the TX queue fills.
                socket.set_error_filter_accept_all()?;
                (lock, BusSocket::SocketCan(socket))
            }
        };
        Ok(Self {
            _lock: lock,
            socket,
            config: config.clone(),
        })
    }
    pub(crate) fn send(&self, f: WireFrame) -> Result<()> {
        match &self.socket {
            #[cfg(target_os = "linux")]
            BusSocket::SocketCan(socket) => {
                let id = ExtendedId::new(f.id).context("Invalid extended CAN ID")?;
                let frame = CanFrame::new(id, &f.data).context("Invalid CAN frame")?;
                socket.write_frame(&frame).with_context(|| {
                    format!("CAN transmit failed on {}. If the TX queue is full, frames are not draining: check CAN wiring, termination, motor power and matching bitrate, then reset the interface. Do not keep retrying the scan", self.config.interface)
                })
            }
            BusSocket::Slcan(socket) => {
                let frame = slcanio::CanFrame::classic(SerialCanId::extended(f.id)?, &f.data)?;
                socket
                    .lock()
                    .expect("SLCAN socket lock poisoned")
                    .as_mut()
                    .context("SLCAN socket closed")?
                    .send(frame)
                    .context(
                        "SLCAN transmit failed; check serial connection, adapter and CAN wiring",
                    )
            }
            BusSocket::GsUsb(device) => {
                ensure!(f.id <= 0x1fff_ffff, "Invalid extended CAN ID");
                let frame = GsUsbFrame::with_data(f.id | CAN_EFF_FLAG, &f.data);
                if std::env::var_os("MOTOMIND_CAN_TRACE").is_some() {
                    eprintln!(
                        "GS-USB TX id={:08x} data={:02x?}",
                        frame.can_id,
                        frame.data()
                    );
                }
                device
                    .lock()
                    .expect("GS-USB device lock poisoned")
                    .device()
                    .send(&frame)
                    .context("GS-USB transmit failed; check USB connection and CAN wiring")
            }
        }
    }
    pub(crate) fn receive(&self) -> Result<Option<WireFrame>> {
        let received = match &self.socket {
            #[cfg(target_os = "linux")]
            BusSocket::SocketCan(socket) => match socket.read_frame() {
                Ok(f) => {
                    if let CanFrame::Error(error) = f {
                        if let Some(reason) = bus_error_reason(error.error_bits(), error.data()) {
                            anyhow::bail!(
                                "{}: {reason}. Check CAN-H/CAN-L, transceiver power, termination and bitrate; reset the interface after fixing the link",
                                self.config.interface
                            );
                        }
                        return Ok(None);
                    }
                    if let Id::Extended(id) = f.id()
                        && f.data().len() == 8
                    {
                        let mut data = [0; 8];
                        data.copy_from_slice(f.data());
                        Some(WireFrame {
                            id: id.as_raw(),
                            data,
                        })
                    } else {
                        None
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
                Err(e) => return Err(e).context("CAN receive failed"),
            },
            BusSocket::Slcan(socket) => {
                let frame = match socket
                    .lock()
                    .expect("SLCAN socket lock poisoned")
                    .as_mut()
                    .context("SLCAN socket closed")?
                    .recv()
                {
                    Ok(frame) => frame,
                    Err(slcanio::Error::Timeout) => return Ok(None),
                    Err(error) => return Err(error).context("SLCAN receive failed"),
                };
                match frame.id() {
                    SerialCanId::Extended(id) if frame.data().len() == 8 && !frame.is_remote() => {
                        let mut data = [0; 8];
                        data.copy_from_slice(frame.data());
                        Some(WireFrame { id, data })
                    }
                    _ => None,
                }
            }
            BusSocket::GsUsb(device) => {
                let mut device = device.lock().expect("GS-USB device lock poisoned");
                let frame = match device.device().read(Duration::from_millis(2)) {
                    Ok(frame) => frame,
                    Err(GsUsbError::ReadTimeout) => return Ok(None),
                    Err(error) => return Err(error).context("GS-USB receive failed"),
                };
                if frame.is_echo_frame() {
                    device.tx_echoes += 1;
                }
                if std::env::var_os("MOTOMIND_CAN_TRACE").is_some() {
                    eprintln!(
                        "GS-USB RX echo={:08x} id={:08x} dlc={} data={:02x?}",
                        frame.echo_id,
                        frame.can_id,
                        frame.can_dlc,
                        frame.data()
                    );
                }
                gsusb_wire_frame(&frame)?
            }
        };
        if let Some(wire) = &received
            && let Some((faults, warnings)) =
                protocol::fault_report(wire, self.config.motor_id, self.config.host_id)
        {
            ensure!(
                faults == 0,
                "Motor type-21 fault: 0x{faults:08x}, warnings=0x{warnings:08x}, driver-chip fault={}",
                faults & 2 != 0
            );
        }
        Ok(received)
    }
    pub(crate) fn flush(&self) -> Result<()> {
        // Bounded even on a busy CAN bus.
        for _ in 0..4096 {
            if self.receive()?.is_none() {
                break;
            }
        }
        Ok(())
    }
    pub(crate) fn wait_for(
        &self,
        timeout: Duration,
        accept: impl Fn(&WireFrame) -> bool,
    ) -> Result<WireFrame> {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if let Some(f) = self.receive()?
                && accept(&f)
            {
                return Ok(f);
            }
            thread::sleep(Duration::from_micros(200));
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "No matching response before CAN deadline",
        )
        .into())
    }
    pub(crate) fn ping(&self, id: u8, timeout: Duration) -> Result<[u8; 8]> {
        self.flush()?;
        self.send(protocol::frame(0, self.config.host_id as u16, id))?;
        // Type-0 replies use destination 0xFE (some firmware uses host ID).
        let f = self.wait_for(timeout, |f| {
            f.id >> 24 == 0
                && (f.id >> 8) as u16 == id as u16
                && [0xfe, self.config.host_id].contains(&(f.id as u8))
        })?;
        Ok(f.data)
    }
    fn probe(&self, id: u8, timeout: Duration) -> Result<Option<[u8; 8]>> {
        match self.ping(id, timeout) {
            Ok(uuid) => Ok(Some(uuid)),
            Err(e)
                if e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::TimedOut) =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
    fn read_parameter(&self, index: u16) -> Result<[u8; 4]> {
        self.flush()?;
        let mut f = protocol::frame(17, self.config.host_id as u16, self.config.motor_id);
        f.data[..2].copy_from_slice(&index.to_le_bytes());
        self.send(f)?;
        let f = self.wait_for(Duration::from_millis(100), |f| {
            f.id >> 24 == 17
                && (f.id >> 8) as u8 == self.config.motor_id
                && f.id as u8 == self.config.host_id
                && f.data[..2] == index.to_le_bytes()
        })?;
        ensure!(
            (f.id >> 16) & 0xff == 0,
            "Motor rejected parameter read 0x{index:04x}: status=0x{:02x}",
            (f.id >> 16) & 0xff
        );
        Ok(f.data[4..].try_into().unwrap())
    }
    pub(crate) fn firmware_version(&self) -> Result<String> {
        self.flush()?;
        self.send(protocol::version_request(
            self.config.host_id,
            self.config.motor_id,
        ))?;
        let f = self.wait_for(Duration::from_millis(200), |f| {
            protocol::firmware_version(f, self.config.motor_id, self.config.host_id).is_some()
        })?;
        let v = protocol::firmware_version(&f, self.config.motor_id, self.config.host_id).unwrap();
        Ok(format!("{}.{}.{}.{}", v[0], v[1], v[2], v[3]))
    }
    fn write_parameter(&self, index: u16, value: [u8; 4]) -> Result<()> {
        let mut f = protocol::frame(18, self.config.host_id as u16, self.config.motor_id);
        f.data[..2].copy_from_slice(&index.to_le_bytes());
        f.data[4..].copy_from_slice(&value);
        self.send(f)?;
        thread::sleep(Duration::from_millis(5));
        ensure!(
            self.read_parameter(index)? == value,
            "Parameter 0x{index:04x} readback mismatch"
        );
        Ok(())
    }
    pub(crate) fn feedback(&self, timeout: Duration) -> Result<Feedback> {
        let f = self.wait_for(timeout, |f| {
            protocol::feedback(
                f,
                self.config.motor_id,
                self.config.host_id,
                &self.config.profile,
            )
            .is_some()
        })?;
        Ok(protocol::feedback(
            &f,
            self.config.motor_id,
            self.config.host_id,
            &self.config.profile,
        )
        .unwrap())
    }
    pub(crate) fn enable_zero_torque(&self, cancel: &AtomicBool) -> Result<Feedback> {
        ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
        self.flush()?;
        // Consume the zero-command reply before enable. Merely flushing right
        // after send can race a reply still in flight and mistake Reset for
        // the enable response.
        self.send(protocol::torque(self.config.motor_id, 0., &self.config.profile).0)?;
        let stopped = self.feedback(Duration::from_millis(50))?;
        ensure!(
            stopped.mode == 0 && stopped.faults == 0,
            "Before enable: expected stopped motor without faults; mode={}, faults=0x{:02x}",
            stopped.mode,
            stopped.faults
        );
        self.flush()?;
        ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
        self.send(protocol::frame(
            3,
            self.config.host_id as u16,
            self.config.motor_id,
        ))?;
        let deadline = Instant::now() + Duration::from_millis(100);
        let mut next_poll = Instant::now() + Duration::from_millis(5);
        let mut last = None;
        while Instant::now() < deadline {
            ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
            if let Some(f) = self.receive()?
                && let Some(fb) = protocol::feedback(
                    &f,
                    self.config.motor_id,
                    self.config.host_id,
                    &self.config.profile,
                )
            {
                ensure!(
                    fb.faults == 0,
                    "Enable rejected: mode={}, faults=0x{:02x}, temperature={:.1} C",
                    fb.mode,
                    fb.faults,
                    fb.temperature
                );
                if fb.mode == 2 {
                    return Ok(fb);
                }
                last = Some(fb.mode);
            }
            if Instant::now() >= next_poll {
                // Obtain fresh status during the bounded transition, with
                // torque and both gains zero; also keep the watchdog alive.
                self.send(protocol::torque(self.config.motor_id, 0., &self.config.profile).0)?;
                next_poll = Instant::now() + Duration::from_millis(5);
            }
            thread::sleep(Duration::from_micros(200));
        }
        anyhow::bail!(
            "Enable did not reach Run mode within 100 ms; last feedback mode={last:?} (0=Reset, 1=Calibration, 2=Run), faults=0x00. No calibration motion started"
        )
    }
    pub(crate) fn watchdog_preflight(
        &self,
        cancel: &AtomicBool,
        motor_state: impl Fn(bool),
    ) -> Result<WatchdogPreflight> {
        let bus = self;
        let c = &self.config;
        // Program raw firmware ticks and verify actual expiry below. Tick periods
        // differ across published firmware revisions; do not silently assume ms.
        // The nonzero watchdog is retained after the run; no flash save is issued.
        bus.write_parameter(0x7028, 2000_u32.to_le_bytes())?;
        bus.send(protocol::write_u8(c.host_id, c.motor_id, 0x7005, 0))?;
        ensure!(
            bus.read_parameter(0x7005)?[0] == 0,
            "Failed to select torque/operation mode"
        );
        ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
        bus.send(protocol::active_reporting(c.host_id, c.motor_id, true))?;
        let _reporting = ActiveReportingGuard(bus);
        bus.enable_zero_torque(cancel)
            .context("Watchdog preflight could not enable motor at zero torque")?;
        motor_state(true);
        let watchdog_start = Instant::now();
        let echoes_before = bus.gsusb_tx_echoes();
        let mut active_reports = 0;
        let mut latest_report = None;
        let mut addressed_frames = 0;
        let mut quiet_frames = Vec::new();
        let mut quiet_frames_omitted = 0;
        while watchdog_start.elapsed() < Duration::from_millis(300) {
            ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
            if let Some(frame) = bus.receive()? {
                let elapsed = watchdog_start.elapsed();
                if frame.id as u8 == c.motor_id {
                    addressed_frames += 1;
                }
                let trace_frame = QuietCanFrame {
                    elapsed_ms: elapsed.as_millis(),
                    id: format!("{:08X}", frame.id),
                    data: frame
                        .data
                        .iter()
                        .map(|byte| format!("{byte:02X}"))
                        .collect(),
                };
                if quiet_frames.len() == 128 {
                    // Preserve the first and last 64 frames if the bus is busy.
                    quiet_frames.remove(64);
                    quiet_frames_omitted += 1;
                }
                quiet_frames.push(trace_frame);
                if let Some(feedback) =
                    protocol::active_feedback(&frame, c.motor_id, c.host_id, &c.profile)
                {
                    active_reports += 1;
                    latest_report = Some((feedback, elapsed));
                }
            }
        }
        let gsusb_tx_echoes = echoes_before
            .zip(bus.gsusb_tx_echoes())
            .map(|(before, after)| after - before);
        // Type-24 reports reflect status without sending a new motor command.
        // Require a recent report; older firmware may not support this feature.
        if active_reports >= 3
            && let Some((feedback, observed_at)) = latest_report.as_ref()
            && *observed_at >= Duration::from_millis(250)
        {
            motor_state(feedback.mode == 2);
            return Ok(WatchdogPreflight {
                feedback: feedback.clone(),
                passive_reports: active_reports,
                last_passive_report_ms: Some(observed_at.as_millis()),
                used_passive_report: true,
                addressed_frames,
                quiet_frames,
                quiet_frames_omitted,
                gsusb_tx_echoes,
            });
        }
        // Legacy fallback: a zero-torque command requests status after the quiet
        // interval. Still fail closed unless it reports Reset with no faults.
        bus.flush()?;
        bus.send(protocol::torque(c.motor_id, 0., &c.profile).0)?;
        let expired = bus.feedback(Duration::from_millis(50))?;
        motor_state(expired.mode == 2);
        Ok(WatchdogPreflight {
            feedback: expired,
            passive_reports: active_reports,
            last_passive_report_ms: latest_report.map(|(_, at)| at.as_millis()),
            used_passive_report: false,
            addressed_frames,
            quiet_frames,
            quiet_frames_omitted,
            gsusb_tx_echoes,
        })
    }
    pub fn stop(&self) -> Result<()> {
        self.send(protocol::frame(
            4,
            self.config.host_id as u16,
            self.config.motor_id,
        ))
    }
    pub(crate) fn stopped(&self) -> Result<Feedback> {
        self.flush()?;
        self.stop()?;
        let fb = self.feedback(Duration::from_millis(100))?;
        ensure!(fb.mode == 0, "Motor did not acknowledge stopped mode");
        ensure!(
            fb.velocity.abs() < 0.15,
            "Shaft is still moving; wait before changing settings"
        );
        Ok(fb)
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        if let BusSocket::Slcan(socket) = &mut self.socket
            && let Ok(slot) = socket.get_mut()
            && let Some(socket) = slot.take()
        {
            let _ = socket.close();
        }
    }
}

// Linux <linux/can/error.h>: decode bitfields ourselves because a frame can
// contain several error classes simultaneously (as this adapter reports).
#[cfg(target_os = "linux")]
fn bus_error_reason(bits: u32, data: &[u8]) -> Option<&'static str> {
    let controller = data.get(1).copied().unwrap_or(0);
    let protocol = data.get(2).copied().unwrap_or(0);
    if bits & 0x40 != 0 {
        Some("CAN BUS-OFF: controller stopped after repeated bus errors")
    } else if bits & 0x08 != 0 && protocol & 0x08 != 0 {
        Some("CAN bit error: adapter could not drive/read back a dominant bit")
    } else if bits & 0x08 != 0 && protocol & 0x10 != 0 {
        Some("CAN bit error: adapter could not drive/read back a recessive bit")
    } else if bits & 0x20 != 0 {
        Some("CAN acknowledgement error: no other node acknowledged transmission")
    } else if bits & 0x04 != 0 && controller & 0x30 != 0 {
        Some("CAN ERROR-PASSIVE: controller has accumulated bus errors")
    } else if bits & 0x04 != 0 && controller & 0x0f != 0 {
        Some("CAN controller warning or receive/transmit overflow")
    } else if bits & 0x08 != 0 {
        Some("CAN protocol error: received or transmitted an invalid bit/frame sequence")
    } else if bits & 0x91 != 0 {
        Some("CAN transceiver, bus or transmit timeout error")
    } else {
        // Arbitration loss and return-to-active/counter notifications alone
        // are not physical faults.
        None
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct CanInterface {
    pub name: String,
    pub up: bool,
    pub state: String,
    pub bitrate: Option<u32>,
}
impl CanInterface {
    pub fn ready(&self) -> bool {
        self.up
            && matches!(
                self.state.as_str(),
                "ERROR-ACTIVE" | "ERROR-WARNING" | "ERROR-PASSIVE"
            )
    }
}

#[cfg(target_os = "linux")]
pub fn available_interfaces() -> Result<Vec<CanInterface>> {
    use neli::{
        consts::{
            nl::{NlmF, NlmFFlags},
            rtnl::{Arphrd, IffFlags, Ifla, IflaInfo, RtAddrFamily, Rtm},
            socket::NlFamily,
        },
        nl::{NlPayload, Nlmsghdr},
        rtnl::Ifinfomsg,
        socket::NlSocketHandle,
        types::RtBuffer,
    };
    let mut socket = NlSocketHandle::connect(NlFamily::Route, None, &[])?;
    let request = Ifinfomsg::new(
        RtAddrFamily::Unspecified,
        Arphrd::None,
        0,
        IffFlags::empty(),
        IffFlags::empty(),
        RtBuffer::new(),
    );
    socket.send(Nlmsghdr::new(
        None,
        Rtm::Getlink,
        NlmFFlags::new(&[NlmF::Request, NlmF::Dump]),
        None,
        None,
        NlPayload::Payload(request),
    ))?;
    let mut interfaces = Vec::new();
    for message in socket.iter::<Rtm, Ifinfomsg>(false) {
        let message = message?;
        let NlPayload::Payload(link) = message.nl_payload else {
            continue;
        };
        let mut attrs = link.rtattrs.get_attr_handle();
        let Ok(info) = attrs.get_nested_attributes::<IflaInfo>(Ifla::Linkinfo) else {
            continue;
        };
        let kind = info.get_attr_payload_as_with_len::<String>(IflaInfo::Kind)?;
        // Inspect the actual link kind before parsing CAN controller attributes:
        // vcan/vxcan share ARPHRD_CAN but carry a different data schema.
        if kind != "can" {
            continue;
        }
        let name = attrs.get_attr_payload_as_with_len::<String>(Ifla::Ifname)?;
        let details = socketcan::CanInterface::open_iface(link.ifi_index as u32)
            .details()
            .with_context(|| format!("Read CAN controller {name}"))?;
        if let Some(interface) = controller_interface(name, details) {
            interfaces.push(interface);
        }
    }
    interfaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(interfaces)
}
#[cfg(not(target_os = "linux"))]
pub fn available_interfaces() -> Result<Vec<CanInterface>> {
    Ok(Vec::new())
}
#[cfg(target_os = "linux")]
fn controller_interface(
    name: String,
    details: socketcan::nl::InterfaceDetails,
) -> Option<CanInterface> {
    use socketcan::nl::CanState;
    // vcan/vxcan have ARPHRD_CAN but no CAN controller state.
    let state = match details.can.state? {
        CanState::ErrorActive => "ERROR-ACTIVE",
        CanState::ErrorWarning => "ERROR-WARNING",
        CanState::ErrorPassive => "ERROR-PASSIVE",
        CanState::BusOff => "BUS-OFF",
        CanState::Stopped => "STOPPED",
        CanState::Sleeping => "SLEEPING",
    };
    Some(CanInterface {
        name,
        up: details.is_up,
        state: state.into(),
        bitrate: details.can.bit_timing.map(|timing| timing.bitrate),
    })
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct DiscoveredMotor {
    pub id: u8,
    pub uuid: [u8; 8],
    pub firmware: Option<String>,
    pub model: Option<String>,
    pub issue: Option<String>,
}
pub fn inspect(c: &Config) -> Result<DiscoveredMotor> {
    let bus = Bus::open(c)?;
    let _guard = StopGuard(&bus);
    bus.stopped()?;
    let uuid = bus.ping(c.motor_id, Duration::from_millis(100))?;
    let firmware = bus.firmware_version()?;
    let model = protocol::firmware_model(&firmware);
    Ok(DiscoveredMotor {
        id: c.motor_id,
        uuid,
        firmware: Some(firmware),
        issue: model.is_none().then(|| "Unknown firmware family".into()),
        model,
    })
}
pub fn scan(
    c: &Config,
    cancel: &AtomicBool,
    progress: impl Fn(WorkProgress),
) -> Result<Vec<DiscoveredMotor>> {
    let mut bus = Bus::open(c)?;
    let mut found = Vec::new();
    for id in 1..=254 {
        ensure!(!cancel.load(Ordering::Relaxed), "Scan cancelled");
        if id != c.host_id
            && let Some(uuid) = bus.probe(id, Duration::from_millis(20))?
        {
            bus.config.motor_id = id;
            let (firmware, issue) = match bus.firmware_version() {
                Ok(version) => (Some(version), None),
                Err(e)
                    if e.downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::TimedOut) =>
                {
                    (
                        None,
                        Some("Firmware did not reply. Check motor power and scan again.".into()),
                    )
                }
                Err(e) => return Err(e),
            };
            let model = firmware.as_deref().and_then(protocol::firmware_model);
            let issue = issue.or_else(|| {
                model
                    .is_none()
                    .then(|| "Unknown firmware family. Check firmware with Motor Studio.".into())
            });
            found.push(DiscoveredMotor {
                id,
                uuid,
                firmware,
                model,
                issue,
            });
        }
        if id % 8 == 0 || id == 254 {
            progress(WorkProgress::scanning(id));
        }
        if id == 16
            && found.is_empty()
            && let BusSocket::GsUsb(device) = &bus.socket
            && device
                .lock()
                .expect("GS-USB device lock poisoned")
                .tx_echoes()
                == 0
        {
            anyhow::bail!(
                "GS-USB sent 1 Mbps CAN probes, but none were acknowledged. Check motor power, CAN-H/CAN-L wiring, termination and bitrate before scanning again"
            );
        }
    }
    Ok(found)
}
pub fn set_zero(c: &Config) -> Result<()> {
    let bus = Bus::open(c)?;
    bus.stopped()?;
    let mut f = protocol::frame(6, c.host_id as u16, c.motor_id);
    f.data[0] = 1;
    bus.send(f)?;
    thread::sleep(Duration::from_millis(30));
    let fb = bus.stopped()?;
    ensure!(
        fb.position.abs() < 0.03,
        "Zero command sent, but feedback is not near zero; inspect motor before retrying"
    );
    Ok(())
}
pub fn disable(c: &Config) -> Result<()> {
    let bus = Bus::open(c)?;
    bus.flush()?;
    bus.stop()?;
    let fb = bus.feedback(Duration::from_millis(100))?;
    ensure!(
        fb.mode == 0,
        "Disable sent, but motor did not acknowledge stopped mode"
    );
    Ok(())
}
pub fn read_firmware(c: &Config) -> Result<String> {
    let bus = Bus::open(c)?;
    bus.stopped()?;
    bus.firmware_version().context(
        "Firmware version query received no valid reply; installed version remains unknown",
    )
}
fn check_firmware_model(c: &Config, version: Option<&str>) -> Result<()> {
    let version = version.context("Firmware did not reply; scan again before calibration")?;
    let model = protocol::firmware_model(version)
        .context("Unknown firmware family; calibration blocked")?;
    ensure!(
        model == c.profile.model,
        "Firmware {version} belongs to {model}, but the detected profile is {}. Scan again; no calibration motion started",
        c.profile.model
    );
    Ok(())
}
pub fn change_id(c: &Config, new_id: u8) -> Result<()> {
    ensure!(
        (1..=254).contains(&new_id) && new_id != c.motor_id && new_id != c.host_id,
        "Choose an unused ID from 1–254, different from host and current ID"
    );
    let bus = Bus::open(c)?;
    bus.stopped()?;
    let uuid = bus.ping(c.motor_id, Duration::from_millis(100))?;
    // Several probes reduce the chance of overlooking an occupied address.
    for _ in 0..3 {
        ensure!(
            bus.probe(new_id, Duration::from_millis(50))?.is_none(),
            "Target CAN ID is already occupied"
        );
    }
    bus.send(protocol::frame(
        7,
        ((new_id as u16) << 8) | c.host_id as u16,
        c.motor_id,
    ))?;
    thread::sleep(Duration::from_millis(50));
    let new_uuid = bus
        .ping(new_id, Duration::from_millis(200))
        .context("ID command sent, but verification failed. Scan the bus before retrying")?;
    ensure!(
        new_uuid == uuid,
        "UUID mismatch after ID change; scan and inspect bus"
    );
    Ok(())
}

pub(crate) struct StopGuard<'a>(pub &'a Bus);
struct ActiveReportingGuard<'a>(&'a Bus);
impl Drop for ActiveReportingGuard<'_> {
    fn drop(&mut self) {
        let c = &self.0.config;
        let _ = self
            .0
            .send(protocol::active_reporting(c.host_id, c.motor_id, false));
    }
}
impl Drop for StopGuard<'_> {
    fn drop(&mut self) {
        for _ in 0..3 {
            let _ = self.0.stop();
            thread::sleep(Duration::from_millis(2));
        }
    }
}

pub fn acquire(
    c: &Config,
    dir: &Path,
    cancel: &AtomicBool,
    progress: impl Fn(WorkProgress),
    motor_state: impl Fn(bool),
) -> Result<()> {
    c.validate()?;
    progress(WorkProgress::recording(0., "Checking motor and watchdog"));
    crate::pipeline::write_plan(c, dir)?;
    let bus = Bus::open(c)?;
    let _guard = StopGuard(&bus);
    let initial = bus
        .stopped()
        .context("Motor did not answer the initial stop request")?;
    motor_state(false);
    ensure!(initial.faults == 0, "Motor has active faults");
    ensure!(
        initial.temperature < c.temperature_limit,
        "Motor is too hot"
    );
    let uuid = bus.ping(c.motor_id, Duration::from_millis(100))?;
    let firmware = match bus.firmware_version() {
        Ok(version) => Some(version),
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::TimedOut) =>
        {
            None
        }
        Err(e) => return Err(e),
    };
    bridge::write_json(
        &dir.join("hardware.json"),
        &serde_json::json!({
            "motor_id": c.motor_id, "uuid": uuid, "firmware_version": firmware,
            "reference_angle_rad": c.reference_angle_rad,
            "profile": c.profile, "uses_documented_ranges": c.profile.uses_documented_ranges(),
            "documentation": "RobStride model manuals 2026-07-13; private CAN types 1 and 2"
        }),
    )?;
    check_firmware_model(c, firmware.as_deref())?;
    let preflight = bus.watchdog_preflight(cancel, &motor_state)?;
    let expired = &preflight.feedback;
    bridge::write_json(
        &dir.join("watchdog_preflight.json"),
        &serde_json::json!({
            "model": c.profile.model, "motor_id": c.motor_id,
            "interface": c.interface,
            "firmware_version": firmware, "timeout_register": "0x7028",
            "timeout_raw_ticks": 2000, "quiet_wait_ms": 300,
            "observed_mode": expired.mode, "observed_faults": expired.faults,
            "passed": expired.mode == 0 && expired.faults == 0,
            "observation": if preflight.used_passive_report { "passive periodic status" } else { "zero-torque status request after quiet interval" },
            "passive_reports": preflight.passive_reports,
            "last_passive_report_ms": preflight.last_passive_report_ms,
            "addressed_frames_during_quiet": preflight.addressed_frames,
            "gsusb_tx_echoes_during_quiet": preflight.gsusb_tx_echoes,
            "quiet_frames": preflight.quiet_frames,
            "quiet_frames_omitted": preflight.quiet_frames_omitted,
            "trace_note": "Accepted extended eight-byte CAN frames received during the 300 ms quiet interval. The app sends no frames in this interval. Standard, remote, and short frames are not included. GS-USB transmit echoes are counted separately."
        }),
    )?;
    ensure!(
        expired.mode == 0 && expired.faults == 0,
        "{} ID {} firmware {}: watchdog 0x7028 read back 2000, but status after a 300 ms pause in app commands was mode={} (0=Reset, 2=Run), faults=0x{:02x}. Calibration blocked: communication-loss stopping was not verified. {} CAN frames addressed to this motor were observed during the quiet interval. See watchdog_preflight.json for the CAN trace.",
        c.profile.model,
        c.motor_id,
        firmware.as_deref().unwrap_or("unknown"),
        expired.mode,
        expired.faults,
        preflight.addressed_frames
    );
    bus.stop()?;
    let mut session = Session {
        schema_version: 1,
        source: "hardware".into(),
        config: c.clone(),
        traces: Vec::new(),
        complete: false,
    };
    let outcome = (|| -> Result<()> {
        for validation in [false, true] {
            let name = if validation { "validation" } else { "training" };
            let recorded = if validation { c.train_seconds } else { 0. };
            let total = c.train_seconds + c.validation_seconds;
            progress(WorkProgress::recording(
                (recorded / total) as f32,
                "Waiting for the shaft to stop",
            ));
            // Stop, wait for a stationary shaft, then clear command state before enable.
            bus.stop()?;
            let settle_deadline = Instant::now() + Duration::from_secs(5);
            let initial = loop {
                thread::sleep(Duration::from_millis(50));
                ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
                if let Ok(fb) = bus.stopped() {
                    break fb;
                }
                ensure!(
                    Instant::now() < settle_deadline,
                    "Motor did not settle after disable"
                );
            };
            ensure!(
                initial.faults == 0,
                "Motor fault bits: 0x{:02x}",
                initial.faults
            );
            ensure!(
                initial.temperature < c.temperature_limit,
                "Motor is too hot"
            );
            let enabled = bus
                .enable_zero_torque(cancel)
                .context("Acquisition could not enable motor at zero torque")?;
            motor_state(true);
            let start = Instant::now();
            let duration = if validation {
                c.validation_seconds
            } else {
                c.train_seconds
            };
            let mut trace = Trace {
                name: name.into(),
                commands: Vec::new(),
                samples: vec![Sample {
                    t: 0.,
                    position: 0.,
                    velocity: enabled.velocity,
                    reported_torque: enabled.torque,
                    temperature: enabled.temperature,
                }],
            };
            let mut encoder =
                EncoderTracker::new(enabled.position, c.profile.position_range, c.speed_limit);
            let mut position = 0.;
            let mut velocity = enabled.velocity;
            let mut next = start;
            let mut last_feedback = start;
            let mut last_progress = start;
            let mut rejected_feedback = None;
            let mut exciter = crate::experiment::Exciter::new(c, validation);
            let result = (|| -> Result<()> {
                while start.elapsed().as_secs_f64() < duration {
                    ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
                    ensure!(
                        last_feedback.elapsed() < Duration::from_millis(50),
                        "Feedback stale for 50 ms"
                    );
                    let now = Instant::now();
                    if now >= next {
                        ensure!(
                            now.duration_since(next) < Duration::from_millis(25),
                            "Control loop missed its deadline by 25 ms"
                        );
                        let t = start.elapsed().as_secs_f64();
                        let command = exciter.command(t, position, velocity, c, validation);
                        let (f, actual) = protocol::torque(c.motor_id, command, &c.profile);
                        bus.send(f)?;
                        trace.commands.push(Command { t, torque: actual });
                        next += Duration::from_secs_f64(1. / c.sample_hz);
                    }
                    // Bounded receive drain keeps cancellation and deadline checks responsive.
                    for _ in 0..128 {
                        let Some(f) = bus.receive()? else {
                            break;
                        };
                        if let Some(fb) = protocol::feedback(&f, c.motor_id, c.host_id, &c.profile)
                        {
                            let received_at = Instant::now();
                            let elapsed = received_at.duration_since(start);
                            ensure!(
                                fb.faults == 0 && fb.mode == 2,
                                "Motor fault / mode changed: faults=0x{:02x}, mode={}",
                                fb.faults,
                                fb.mode
                            );
                            ensure!(
                                fb.temperature < c.temperature_limit,
                                "Temperature limit reached"
                            );
                            ensure!(fb.velocity.abs() < c.speed_limit, "Speed limit reached");
                            position = encoder.update(fb.position, elapsed).inspect_err(|error| {
                                // Include the rejected frame: accepted samples alone
                                // cannot distinguish a jump from a delivery-time burst.
                                // Defer disk I/O until after the motor is stopped.
                                rejected_feedback = Some(serde_json::json!({
                                        "phase": name, "t": elapsed.as_secs_f64(),
                                        "interval_s": received_at.duration_since(last_feedback).as_secs_f64(),
                                        "can_id": f.id, "payload": f.data,
                                        "raw_position_rad": fb.position,
                                        "velocity_rad_s": fb.velocity,
                                        "profile": c.profile, "error": error.to_string(),
                                    }));
                            })?;
                            velocity = fb.velocity;
                            ensure!(position.abs() < c.travel_limit, "Travel limit reached");
                            last_feedback = received_at;
                            trace.samples.push(Sample {
                                t: elapsed.as_secs_f64(),
                                position,
                                velocity,
                                reported_torque: fb.torque,
                                temperature: fb.temperature,
                            });
                        }
                    }
                    if last_progress.elapsed() > Duration::from_millis(250) {
                        // Catch an incompatible wire profile during acquisition,
                        // once displacement is well above encoder quantization.
                        if trace.samples.len() >= 200 && position.abs() > 0.3 {
                            crate::fit::check_wire_scale(&trace, &c.profile)?;
                        }
                        let elapsed = start.elapsed().as_secs_f64().min(duration);
                        progress(WorkProgress::recording(
                            ((recorded + elapsed) / total) as f32,
                            format!(
                                "{} · {} · {elapsed:.1} / {duration:.0} s",
                                if validation { "Validation" } else { "Training" },
                                exciter.phase_name()
                            ),
                        ));
                        last_progress = Instant::now();
                    }
                    thread::sleep(Duration::from_micros(200));
                }
                Ok(())
            })();
            bus.stop()?;
            motor_state(false);
            if let Some(feedback) = rejected_feedback {
                let _ = bridge::write_json(&dir.join("encoder_error.json"), &feedback);
            }
            session.traces.push(trace);
            bridge::write_json(&dir.join("session.json"), &session)?;
            result?;
            progress(WorkProgress::recording(
                ((recorded + duration) / total) as f32,
                format!("{name} recorded"),
            ));
        }
        Ok(())
    })();
    session.complete = outcome.is_ok();
    bridge::write_json(&dir.join("session.json"), &session)?;
    outcome
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;
    #[test]
    fn gsusb_address_and_frame_filter() {
        assert_eq!(gsusb_address("gsusb:3:79").unwrap(), Some((3, 79)));
        assert_eq!(gsusb_address("can0").unwrap(), None);
        for value in ["gsusb:0:79", "gsusb:3:0", "gsusb:3:999", "gsusb:3:79:1"] {
            assert!(gsusb_address(value).is_err());
        }
        let mut frame = GsUsbFrame::with_data(CAN_EFF_FLAG | 0x1234, &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(gsusb_wire_frame(&frame).unwrap().is_none()); // TX echo
        frame.echo_id = u32::MAX;
        let wire = gsusb_wire_frame(&frame).unwrap().unwrap();
        assert_eq!(wire.id, 0x1234);
        assert_eq!(wire.data, [1, 2, 3, 4, 5, 6, 7, 8]);
        frame.can_id = 0x1234;
        assert!(gsusb_wire_frame(&frame).unwrap().is_none()); // Standard ID
        frame.can_id = gs_usb::CAN_ERR_FLAG | 0x40;
        assert!(gsusb_wire_frame(&frame).is_err());
    }
    #[test]
    fn gsusb_160mhz_adapter_uses_observed_one_megabit_timing() {
        let mut bytes = Vec::new();
        for value in [0, 160_000_000_u32, 1, 256, 1, 128, 128, 1, 512, 1] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let capability = DeviceCapability::unpack(&bytes);
        assert_eq!(gsusb_timing(&capability).unwrap(), (59, 60, 40, 20, 1));
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a connected GS-USB adapter; set MOTOMIND_GSUSB_TEST=gsusb:bus:address"]
    fn direct_usb_open_restores_kernel_driver() {
        let interface = std::env::var("MOTOMIND_GSUSB_TEST").unwrap();
        let (usb_bus, usb_address) = gsusb_address(&interface).unwrap().unwrap();
        let before = rusb::devices()
            .unwrap()
            .iter()
            .find(|item| item.bus_number() == usb_bus && item.address() == usb_address)
            .unwrap()
            .open()
            .unwrap()
            .kernel_driver_active(0)
            .unwrap();
        let config = Config {
            interface,
            ..Default::default()
        };
        drop(Bus::open(&config).unwrap());
        let after = rusb::devices()
            .unwrap()
            .iter()
            .find(|item| item.bus_number() == usb_bus && item.address() == usb_address)
            .unwrap()
            .open()
            .unwrap()
            .kernel_driver_active(0)
            .unwrap();
        assert_eq!(after, before);
    }
    #[test]
    fn firmware_family_mismatch_blocks_before_calibration() {
        let mut c = Config {
            profile: Profile::presets()[0].clone(),
            ..Default::default()
        };
        assert!(check_firmware_model(&c, Some("0.0.3.32")).is_ok());
        let error = check_firmware_model(&c, Some("0.5.0.14"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("RS-05") && error.contains("RS-00"));
        assert!(error.contains("no calibration motion started"));
        c.profile = Profile::presets()[5].clone();
        assert!(check_firmware_model(&c, Some("0.5.0.14")).is_ok());
        assert!(protocol::firmware_model("1.5.0.14").is_none());
        assert!(protocol::firmware_model("invalid").is_none());
        assert!(check_firmware_model(&c, None).is_err());
        assert!(check_firmware_model(&c, Some("1.5.0.14")).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn interface_picker_excludes_virtual_buses_and_checks_controller_state() {
        use socketcan::nl::{CanState, InterfaceDetails};
        let mut details = InterfaceDetails::default();
        assert!(controller_interface("vcan0".into(), details.clone()).is_none());
        for (state, up, ready) in [
            (CanState::ErrorActive, true, true),
            (CanState::BusOff, true, false),
            (CanState::Stopped, false, false),
            (CanState::Sleeping, true, false),
        ] {
            details.is_up = up;
            details.can.state = Some(state);
            assert_eq!(
                controller_interface("can0".into(), details.clone())
                    .unwrap()
                    .ready(),
                ready
            );
        }
    }
    #[test]
    fn interface_lock_rejects_paths_and_command_fragments() {
        for name in [
            "",
            ".",
            "..",
            "../can0",
            "can0;id",
            "can0\nup",
            "a b",
            "0123456789abcdef",
        ] {
            assert!(lock_interface(name).is_err());
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated vcan interface named vcalwatch"]
    fn virtual_enable_handshake_handles_reset_reply_fault_and_timeout() {
        // Never allow this active mock-motor test to open a physical interface.
        let device = std::fs::canonicalize("/sys/class/net/vcalwatch").unwrap();
        assert!(device.starts_with("/sys/devices/virtual/net"));
        for scenario in 0..3 {
            let c = Config {
                interface: "vcalwatch".into(),
                motor_id: 7,
                ..Default::default()
            };
            let mock = CanSocket::open(&c.interface).unwrap();
            mock.set_nonblocking(true).unwrap();
            let done = std::sync::Arc::new(AtomicBool::new(false));
            let stop = done.clone();
            let worker = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(2);
                let mut enabled = false;
                let mut commands = Vec::new();
                while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                    match mock.read_frame() {
                        Ok(f) => {
                            let Id::Extended(id) = f.id() else { continue };
                            let kind = (id.as_raw() >> 24) as u8;
                            commands.push(kind);
                            let (mode, fault) = match kind {
                                1 => {
                                    assert_eq!(&f.data()[4..], &[0, 0, 0, 0]);
                                    assert_eq!((id.as_raw() >> 8) as u16, 32768);
                                    (if enabled && scenario == 0 { 2 } else { 0 }, 0)
                                }
                                3 => {
                                    assert_eq!(commands[0], 1);
                                    enabled = true;
                                    // First enable acknowledgement can still say Reset.
                                    (0, if scenario == 1 { 1 } else { 0 })
                                }
                                _ => panic!("Unexpected command during zero-torque enable"),
                            };
                            let reply = protocol::frame(2, (mode << 14) | (fault << 8) | 7, 253);
                            mock.write_frame(
                                &CanFrame::new(ExtendedId::new(reply.id).unwrap(), &reply.data)
                                    .unwrap(),
                            )
                            .unwrap();
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_micros(100))
                        }
                        Err(e) => panic!("Mock receive failed: {e}"),
                    }
                }
                commands
            });
            let bus = Bus::open(&c).unwrap();
            let result = bus.enable_zero_torque(&AtomicBool::new(false));
            done.store(true, Ordering::Relaxed);
            let commands = worker.join().unwrap();
            match scenario {
                0 => {
                    assert_eq!(result.unwrap().mode, 2);
                    assert_eq!(&commands[..2], &[1, 3]);
                    assert!(commands.len() >= 3 && commands[2..].iter().all(|kind| *kind == 1));
                }
                1 => assert!(result.unwrap_err().to_string().contains("faults=0x01")),
                _ => assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("last feedback mode=Some(0)")
                ),
            }
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn captured_adapter_fault_reports_the_dominant_bit_failure() {
        // Observed gs_usb frame: 2000000C#000c080000006000.
        let reason = bus_error_reason(0x0c, &[0, 0x0c, 0x08, 0, 0, 0, 0x60, 0]).unwrap();
        assert!(reason.contains("dominant bit"));
        assert!(bus_error_reason(0x40, &[0; 8]).unwrap().contains("BUS-OFF"));
        assert!(
            bus_error_reason(0x20, &[0; 8])
                .unwrap()
                .contains("acknowledgement")
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn normal_arbitration_and_recovery_are_not_faults() {
        assert!(bus_error_reason(0x02, &[0; 8]).is_none());
        assert!(bus_error_reason(0x04, &[0, 0x40, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(bus_error_reason(0x200, &[0; 8]).is_none());
    }
}
