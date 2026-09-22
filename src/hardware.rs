//! Linux SocketCAN transport for the RobStride extended-frame private protocol.
use crate::{
    bridge,
    protocol::{self, Feedback, WireFrame},
    types::*,
};
use anyhow::{Context, Result, ensure};
use socketcan::{CanFrame, CanSocket, EmbeddedFrame, ExtendedId, Id, Socket, SocketOptions};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub struct Bus {
    _lock: std::fs::File,
    socket: CanSocket,
    config: Config,
}
impl Bus {
    pub fn open(config: &Config) -> Result<Self> {
        ensure!(
            config
                .interface
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_- .".contains(c))
                && !config.interface.is_empty(),
            "Invalid CAN interface name"
        );
        let locks = crate::paths::lock_dir()?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(locks.join(format!("{}.lock", config.interface)))?;
        lock.try_lock()
            .context("Another calibration/update operation owns this CAN interface")?;
        let socket = CanSocket::open(&config.interface)
            .context("Open SocketCAN interface (configure bitrate and bring it up first)")?;
        socket.set_nonblocking(true)?;
        // SocketCAN hides bus error frames by default. Receive them so scans
        // stop at the actual fault, before unacknowledged requests fill TX.
        socket.set_error_filter_accept_all()?;
        Ok(Self {
            _lock: lock,
            socket,
            config: config.clone(),
        })
    }
    pub(crate) fn send(&self, f: WireFrame) -> Result<()> {
        let id = ExtendedId::new(f.id).context("Invalid extended CAN ID")?;
        let frame = CanFrame::new(id, &f.data).context("Invalid CAN frame")?;
        self.socket.write_frame(&frame).with_context(|| {
            format!("CAN transmit failed on {}. If the TX queue is full, frames are not draining: check CAN wiring, termination, motor power and matching bitrate, then reset the interface. Do not keep retrying the scan", self.config.interface)
        })
    }
    pub(crate) fn receive(&self) -> Result<Option<WireFrame>> {
        match self.socket.read_frame() {
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
                    let wire = WireFrame {
                        id: id.as_raw(),
                        data,
                    };
                    if let Some((faults, warnings)) =
                        protocol::fault_report(&wire, self.config.motor_id, self.config.host_id)
                    {
                        ensure!(
                            faults == 0,
                            "Motor type-21 fault: 0x{faults:08x}, warnings=0x{warnings:08x}, driver-chip fault={}",
                            faults & 2 != 0
                        );
                    }
                    return Ok(Some(wire));
                }
                Ok(None)
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e).context("CAN receive failed"),
        }
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
    fn feedback(&self, timeout: Duration) -> Result<Feedback> {
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
    fn enable_zero_torque(&self, cancel: &AtomicBool) -> Result<Feedback> {
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

// Linux <linux/can/error.h>: decode bitfields ourselves because a frame can
// contain several error classes simultaneously (as this adapter reports).
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

struct StopGuard<'a>(&'a Bus);
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
) -> Result<()> {
    c.validate()?;
    progress(WorkProgress::recording(0., "Checking motor and watchdog"));
    crate::pipeline::write_plan(c, dir)?;
    let bus = Bus::open(c)?;
    let _guard = StopGuard(&bus);
    let initial = bus.stopped()?;
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
            "profile": c.profile, "uses_documented_ranges": c.profile.uses_documented_ranges(),
            "documentation": "RobStride model manuals 2026-07-13; private CAN types 1 and 2"
        }),
    )?;
    check_firmware_model(c, firmware.as_deref())?;
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
    bus.enable_zero_torque(cancel)
        .context("Watchdog preflight could not enable motor at zero torque")?;
    let watchdog_start = Instant::now();
    while watchdog_start.elapsed() < Duration::from_millis(300) {
        ensure!(!cancel.load(Ordering::Relaxed), "Calibration stopped");
        thread::sleep(Duration::from_millis(2));
    }
    bus.flush()?;
    bus.send(protocol::torque(c.motor_id, 0., &c.profile).0)?;
    let expired = bus.feedback(Duration::from_millis(50))?;
    bridge::write_json(
        &dir.join("watchdog_preflight.json"),
        &serde_json::json!({
            "model": c.profile.model, "motor_id": c.motor_id,
            "firmware_version": firmware, "timeout_register": "0x7028",
            "timeout_raw_ticks": 2000, "quiet_wait_ms": 300,
            "observed_mode": expired.mode, "observed_faults": expired.faults,
            "passed": expired.mode == 0 && expired.faults == 0,
            "observation": "Feedback requested with zero torque after the quiet interval; not a measured expiry timestamp."
        }),
    )?;
    ensure!(
        expired.mode == 0 && expired.faults == 0,
        "{} ID {} firmware {}: watchdog 0x7028 read back 2000, but status after 300 ms without commands was mode={} (0=Reset, 2=Run), faults=0x{:02x}. Calibration blocked: communication-loss stopping was not verified. Check firmware watchdog support and other CAN senders. See watchdog_preflight.json",
        c.profile.model,
        c.motor_id,
        firmware.as_deref().unwrap_or("unknown"),
        expired.mode,
        expired.faults
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
            let mut last_raw = enabled.position;
            let mut position = 0.;
            let mut velocity = enabled.velocity;
            let mut next = start;
            let mut last_feedback = start;
            let mut last_progress = start;
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
                            let mut delta = fb.position - last_raw;
                            let span = c.profile.position_range * 2.;
                            if delta > span / 2. {
                                delta -= span;
                            } else if delta < -span / 2. {
                                delta += span;
                            }
                            ensure!(
                                delta.abs()
                                    < c.speed_limit * last_feedback.elapsed().as_secs_f64() + 0.02,
                                "Implausible encoder jump; check wire profile/wrapping"
                            );
                            position += delta;
                            last_raw = fb.position;
                            velocity = fb.velocity;
                            ensure!(position.abs() < c.travel_limit, "Travel limit reached");
                            last_feedback = Instant::now();
                            trace.samples.push(Sample {
                                t: start.elapsed().as_secs_f64(),
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
    #[test]
    fn normal_arbitration_and_recovery_are_not_faults() {
        assert!(bus_error_reason(0x02, &[0; 8]).is_none());
        assert!(bus_error_reason(0x04, &[0, 0x40, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(bus_error_reason(0x200, &[0; 8]).is_none());
    }
}
