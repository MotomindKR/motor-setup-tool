//! Headless commands share the GUI's acquisition, manual control, and fitting code.
use crate::{
    bridge, can_admin, experiment, firmware, hardware, manual, pipeline, registers, types::*,
};
use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(
    name = "motor-setup-tool",
    version,
    about = "Motomind motor calibration and setup",
    long_about = "Motomind motor calibration and setup. Run without arguments to open the GUI.\nSubcommands run without a display. Results go to stdout as JSON; progress goes to stderr.",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    legacy: Legacy,
}

// Keep compatibility with earlier CLI and screenshot commands while rejecting
// unknown arguments instead of accidentally opening the native UI.
#[derive(Args)]
struct Legacy {
    #[arg(long, hide = true, group = "legacy_action")]
    list_can: bool,
    #[arg(long, hide = true, group = "legacy_action")]
    self_check: bool,
    #[arg(long, hide = true, group = "legacy_action")]
    scan: Option<String>,
    #[arg(long, hide = true, group = "legacy_action")]
    firmware: Option<String>,
    #[arg(long, hide = true, group = "legacy_action")]
    update_firmware: Option<String>,
    #[arg(long, hide = true, group = "legacy_action")]
    analyze: Option<PathBuf>,
    #[arg(long, hide = true)]
    motor_id: Option<u8>,
    #[arg(long, hide = true)]
    model: Option<String>,
    /// Open a saved recording in the GUI.
    #[arg(long)]
    open: Option<PathBuf>,
    #[arg(long, hide = true)]
    refit: Option<PathBuf>,
    #[arg(long, hide = true)]
    connect: Option<String>,
    #[arg(long, hide = true)]
    screenshot: Option<PathBuf>,
    #[arg(long, hide = true, requires = "screenshot", value_parser = ["light", "dark"])]
    screenshot_theme: Option<String>,
    #[arg(long, hide = true, requires = "screenshot", value_parser = ["calibrate", "test", "motor", "files"])]
    screenshot_tab: Option<String>,
    #[arg(long, hide = true, requires = "screenshot")]
    screenshot_during_fit: bool,
}

#[derive(Subcommand)]
enum Command {
    /// List, bring up, or restart a CAN interface at 1 Mbps.
    Can {
        #[command(subcommand)]
        command: CanCommand,
    },
    /// Discover motor IDs, firmware, and models. Motors remain disabled.
    Scan(BusArgs),
    /// Read a motor's identity and firmware; disables the selected motor.
    Info(Target),
    /// Measure disabled-motor command-to-feedback timing at 200 Hz.
    Latency(Target),
    /// Show a model's single calibration preset without connecting hardware.
    Plan {
        #[arg(long)]
        model: String,
    },
    /// Return the current calibration preview without opening hardware.
    #[command(hide = true)]
    Preview,
    /// Record and fit a real motor; writes the same artifacts as the GUI.
    Calibrate(Calibrate),
    /// Refit a saved real recording; replaces analysis artifacts.
    Analyze { directory: PathBuf },
    /// Stream disabled-motor feedback as JSON lines until Ctrl+C or timeout.
    Monitor {
        #[command(flatten)]
        target: Target,
        #[arg(long, value_parser = seconds)]
        seconds: Option<f64>,
    },
    /// Stream a monitored manual session controlled by JSON intent lines on stdin.
    #[command(hide = true)]
    ManualSession(Target),
    /// Run a bounded jog, then disable. Ctrl+C also disables the motor.
    Jog {
        #[command(flatten)]
        target: Target,
        /// Output-shaft velocity in rad/s; negative reverses direction.
        #[arg(long, allow_hyphen_values = true)]
        speed: f64,
        #[arg(long, value_parser = seconds)]
        seconds: f64,
        #[arg(long, required = true)]
        yes: bool,
    },
    /// Disable the selected motor and verify its stopped mode.
    Stop(Target),
    /// Set the stationary motor's current position to zero.
    Zero {
        #[command(flatten)]
        target: Target,
        #[arg(long, required = true)]
        yes: bool,
    },
    /// Change CAN ID, checking for collisions and verifying motor identity.
    SetId {
        #[command(flatten)]
        target: Target,
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=254))]
        new_id: u8,
        #[arg(long, required = true)]
        yes: bool,
    },
    /// Check or install verified firmware for the detected model.
    Firmware {
        #[command(subcommand)]
        command: FirmwareCommand,
    },
    /// Read documented persistent registers or save a verified change.
    Register {
        #[command(subcommand)]
        command: RegisterCommand,
    },
}

#[derive(Subcommand)]
enum RegisterCommand {
    /// List documented persistent setup registers.
    List,
    /// Read a register from a disabled motor.
    Read {
        #[command(flatten)]
        target: Target,
        #[arg(long, value_parser = register_index)]
        index: u16,
    },
    /// Write a documented persistent setting and save it to motor storage.
    Write {
        #[command(flatten)]
        target: Target,
        #[arg(long, value_parser = register_index)]
        index: u16,
        #[arg(long, allow_negative_numbers = true)]
        value: f64,
        #[arg(long)]
        uuid: String,
        #[arg(long)]
        expected_raw: String,
        #[arg(long, required = true)]
        yes: bool,
    },
}

fn register_index(text: &str) -> std::result::Result<u16, String> {
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16).map_err(|_| "Enter a valid hex register index".into())
    } else {
        text.parse()
            .map_err(|_| "Enter a valid decimal register index".into())
    }
}

#[derive(Subcommand)]
enum CanCommand {
    /// List physical SocketCAN interfaces without sending frames.
    List,
    /// List serial ports that can be used by SLCAN adapters.
    SerialList,
    /// List GS-USB adapters available for direct USB access.
    UsbList,
    /// Bring a down interface up at 1 Mbps.
    Up(CanUp),
    /// Take an idle interface down, then bring it up at 1 Mbps.
    Restart(CanUp),
}
#[derive(Args)]
struct CanUp {
    interface: String,
    #[arg(long, value_enum, default_value = "sudo")]
    auth: can_admin::Auth,
}
#[derive(Args)]
struct BusArgs {
    #[arg(long, default_value = "can0")]
    can: String,
    #[arg(long, default_value_t = 253, value_parser = clap::value_parser!(u8).range(1..=254))]
    host_id: u8,
}
#[derive(Args)]
struct Target {
    #[command(flatten)]
    bus: BusArgs,
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..=254))]
    id: u8,
}
impl Target {
    fn config(&self) -> Result<Config> {
        let c = Config {
            interface: self.bus.can.clone(),
            motor_id: self.id,
            host_id: self.bus.host_id,
            ..Default::default()
        };
        c.validate()?;
        Ok(c)
    }
}
#[derive(Args)]
struct Calibrate {
    #[command(flatten)]
    target: Target,
    /// New recording directory; an existing directory is never overwritten.
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long, default_value_t = 40., value_parser = seconds)]
    train_seconds: f64,
    #[arg(long, default_value_t = 20., value_parser = seconds)]
    validation_seconds: f64,
    #[arg(long)]
    torque_limit: Option<f64>,
    #[arg(long)]
    speed_limit: Option<f64>,
    #[arg(long)]
    travel_limit: Option<f64>,
    /// Read a complete, validated GUI configuration from stdin.
    #[arg(long, hide = true)]
    config_stdin: bool,
    /// Confirm the motor is secured, shaft clear, and preset limits reviewed.
    #[arg(long, required = true)]
    yes: bool,
}
#[derive(Subcommand)]
enum FirmwareCommand {
    /// Compare installed firmware with the bundled verified release catalog.
    Check(Target),
    /// Download and verify the selected official image before an update.
    Prepare(Target),
    /// Update firmware. Once transfer starts, keep power on until it finishes.
    Update {
        #[command(flatten)]
        target: Target,
        #[arg(long, required = true)]
        yes: bool,
    },
}

fn seconds(text: &str) -> std::result::Result<f64, String> {
    let value: f64 = text.parse().map_err(|_| "Enter a number of seconds")?;
    if value.is_finite() && (0.05..=3600.).contains(&value) {
        Ok(value)
    } else {
        Err("Duration must be 0.05–3600 seconds".into())
    }
}

fn output(value: &impl Serialize) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, value)?;
    writeln!(out)?;
    Ok(())
}

fn output_line(value: &impl Serialize) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

#[derive(Default)]
struct Progress(Mutex<Option<(WorkPhase, i32)>>);
impl Progress {
    fn show(&self, p: WorkProgress) {
        let percent = (p.fraction * 100.).floor() as i32;
        let current = (p.phase, percent);
        let mut last = self.0.lock().unwrap();
        if last.as_ref() == Some(&current) {
            return;
        }
        *last = Some(current);
        if io::stderr().is_terminal() {
            let width = (percent.clamp(0, 100) / 5) as usize;
            eprintln!("[{}{}] {p}", "=".repeat(width), " ".repeat(20 - width));
        } else {
            eprintln!("{p}");
        }
    }
}

fn preset(model: &str) -> Result<Config> {
    let profile = Profile::presets()
        .into_iter()
        .find(|p| p.model == model)
        .context("Supported models: RS-00 through RS-06")?;
    let mut config = Config {
        profile,
        ..Default::default()
    };
    config.apply_spec_limits();
    config.validate()?;
    Ok(config)
}

fn requested_config(detected: Config, requested: Config) -> Result<Config> {
    ensure!(
        requested.interface == detected.interface
            && requested.motor_id == detected.motor_id
            && requested.host_id == detected.host_id
            && requested.profile == detected.profile,
        "Motor identity or wire profile changed; scan again"
    );
    ensure!(
        requested.experiment == experiment::Experiment::Mixed
            && requested.excitation_revision == 1
            && requested.baseline.static_friction == 0.,
        "New recordings use the current mixed calibration suite and constant friction baseline"
    );
    requested.validate()?;
    Ok(requested)
}

fn preview_config(c: &Config) -> Result<serde_json::Value> {
    ensure!(
        c.profile.uses_documented_ranges(),
        "Use a supported motor profile"
    );
    ensure!(
        c.experiment == experiment::Experiment::Mixed,
        "Use the mixed calibration suite"
    );
    c.validate()?;
    let samples = 1200;
    let mut t = Vec::with_capacity(samples + 1);
    let mut velocity = Vec::with_capacity(samples + 1);
    let mut torque = Vec::with_capacity(samples + 1);
    for index in 0..=samples {
        let time = index as f64 * c.train_seconds / samples as f64;
        let (v, q) = experiment::preview(c, time, false);
        t.push(time);
        velocity.push(v);
        torque.push(q);
    }
    Ok(
        json!({"spec":c.profile.spec(),"segments":experiment::plan(c, false),
        "t":t,"velocity":velocity,"torque":torque}),
    )
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ManualInput {
    Intent {
        enabled: bool,
        direction: i8,
        speed: f64,
        reviewed: bool,
    },
    Stop,
}

fn manual_session(target: Target, cancel: &AtomicBool) -> Result<()> {
    let mut first = String::new();
    ensure!(
        io::stdin().read_line(&mut first)? > 0,
        "Manual session needs a configuration"
    );
    let requested: Config = serde_json::from_str(&first).context("Invalid manual configuration")?;
    let (detected, motor) = detected(&target)?;
    let config = requested_config(detected, requested)?;
    let session = manual::Session::start(config.clone(), motor.uuid);
    let (tx, rx) = mpsc::channel::<Result<ManualInput>>();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let message = line
                .context("Read manual intent")
                .and_then(|line| serde_json::from_str(&line).context("Invalid manual intent"));
            if tx.send(message).is_err() {
                return;
            }
        }
        let _ = tx.send(Ok(ManualInput::Stop));
    });
    let started = Instant::now();
    let mut last_received = None;
    let mut last_enabled = false;
    let mut last_preparing = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        while let Ok(message) = rx.try_recv() {
            match message? {
                ManualInput::Intent {
                    enabled,
                    direction,
                    speed,
                    reviewed,
                } => {
                    ensure!(
                        (-1..=1).contains(&direction)
                            && speed.is_finite()
                            && (0.01..=manual::max_speed(&config)).contains(&speed),
                        "Invalid manual speed or direction"
                    );
                    let mut intent = session.intent.lock().unwrap();
                    intent.enabled = enabled && reviewed;
                    intent.direction = if intent.enabled { direction } else { 0 };
                    intent.speed = speed;
                    intent.heartbeat = Instant::now();
                }
                ManualInput::Stop => {
                    drop(session);
                    return Ok(());
                }
            }
        }
        let state = session.snapshot();
        let fresh = state
            .received
            .is_some_and(|at| at.elapsed() < Duration::from_millis(200));
        if state.received != last_received
            || state.enabled != last_enabled
            || state.preparing != last_preparing
            || session.finished()
        {
            let fb = state.feedback.as_ref();
            output_line(&json!({"t":started.elapsed().as_secs_f64(),"id":target.id,
                "sample_t":state.received.map(|at|at.saturating_duration_since(started).as_secs_f64()),
                "enabled":state.enabled,"preparing":state.preparing,"fresh":fresh,
                "position_rad":fb.map(|f|f.position),"velocity_rad_s":fb.map(|f|f.velocity),
                "torque_nm":fb.map(|f|f.torque),"temperature_c":fb.map(|f|f.temperature),
                "mode":fb.map(|f|f.mode),"faults":fb.map(|f|f.faults),
                "stop_reason":state.stop_reason.as_deref(),"error":state.error.as_deref()}))?;
            last_received = state.received;
            last_enabled = state.enabled;
            last_preparing = state.preparing;
        }
        if session.finished() {
            let error = state
                .error
                .unwrap_or_else(|| "Manual session stopped".into());
            drop(session);
            anyhow::bail!(error);
        }
        thread::sleep(Duration::from_millis(20));
    }
    drop(session);
    Ok(())
}

fn detected(target: &Target) -> Result<(Config, hardware::DiscoveredMotor)> {
    let base = target.config()?;
    let motor = hardware::inspect(&base)?;
    let mut config = preset(
        motor
            .model
            .as_deref()
            .context("Unknown firmware family; cannot select a motor preset")?,
    )?;
    config.interface = base.interface;
    config.motor_id = base.motor_id;
    config.host_id = base.host_id;
    config.validate()?;
    Ok((config, motor))
}

pub fn dispatch() -> Result<bool> {
    let args = Cli::parse();
    let Some(command) = args.command else {
        return Ok(false);
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))?;
    let result = execute(command, &cancel);
    if cancel.load(Ordering::Relaxed) {
        anyhow::bail!("Command cancelled; active motor control has stopped");
    }
    result?;
    Ok(true)
}

fn execute(command: Command, cancel: &AtomicBool) -> Result<()> {
    let progress = Progress::default();
    match command {
        Command::Can { command } => {
            match command {
                CanCommand::List => {}
                CanCommand::SerialList => {
                    let mut ports = serialport::available_ports()?
                        .into_iter()
                        .map(|port| port.port_name)
                        .filter(|name| {
                            #[cfg(target_os = "linux")]
                            if name
                                .strip_prefix("/dev/ttyS")
                                .is_some_and(|suffix| suffix.parse::<u32>().is_ok())
                            {
                                return false;
                            }
                            true
                        })
                        .collect::<Vec<_>>();
                    ports.sort();
                    return output(&ports);
                }
                CanCommand::UsbList => return output(&hardware::available_usb_adapters()?),
                CanCommand::Up(args) => can_admin::up(&args.interface, false, args.auth, cancel)?,
                CanCommand::Restart(args) => {
                    can_admin::up(&args.interface, true, args.auth, cancel)?
                }
            }
            output(&hardware::available_interfaces()?)
        }
        Command::Scan(args) => {
            let c = Config {
                interface: args.can,
                host_id: args.host_id,
                ..Default::default()
            };
            output(&hardware::scan(&c, cancel, |p| progress.show(p))?)
        }
        Command::Info(target) => output(&hardware::inspect(&target.config()?)?),
        Command::Latency(target) => {
            let (config, _) = detected(&target)?;
            output(&hardware::measure_feedback_latency(&config, cancel)?)
        }
        Command::Plan { model } => output(&preset(&model)?),
        Command::Preview => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            let config: Config =
                serde_json::from_str(&input).context("Invalid preview configuration")?;
            output(&preview_config(&config)?)
        }
        Command::Calibrate(args) => {
            let (mut config, motor) = detected(&args.target)?;
            if args.config_stdin {
                let mut input = String::new();
                io::stdin().read_to_string(&mut input)?;
                let requested: Config =
                    serde_json::from_str(&input).context("Invalid calibration configuration")?;
                config = requested_config(config, requested)?;
            } else {
                config.train_seconds = args.train_seconds;
                config.validation_seconds = args.validation_seconds;
                if let Some(v) = args.torque_limit {
                    config.torque_limit = v;
                }
                if let Some(v) = args.speed_limit {
                    config.speed_limit = v;
                }
                if let Some(v) = args.travel_limit {
                    config.travel_limit = v;
                }
            }
            config.validate()?;
            ensure!(
                !cancel.load(Ordering::Relaxed),
                "Cancelled before calibration"
            );
            let dir = if let Some(dir) = args.output {
                std::fs::create_dir(&dir)
                    .context("Choose a new recording directory with an existing parent")?;
                dir
            } else {
                bridge::new_run_dir()?
            };
            bridge::write_json(&dir.join("config.json"), &config)?;
            eprintln!(
                "{} · ID {} · torque {:.3} Nm · speed {:.3} rad/s · travel ±{:.3} rad",
                config.profile.model,
                motor.id,
                config.torque_limit,
                config.speed_limit,
                config.travel_limit
            );
            eprintln!("Recording to {}. Ctrl+C stops the motor.", dir.display());
            if let Err(e) = hardware::acquire(&config, &dir, cancel, |p| progress.show(p), |_| {}) {
                let _ =
                    bridge::write_json(&dir.join("error.json"), &json!({"error":format!("{e:#}")}));
                return Err(e);
            }
            let report = pipeline::analyze(&dir, cancel, |p| progress.show(p))?;
            output(
                &json!({"directory":dir,"accepted":report.accepted,"fitted":report.fitted,"warnings":report.warnings}),
            )
        }
        Command::Analyze { directory } => output(&pipeline::analyze(&directory, cancel, |p| {
            progress.show(p)
        })?),
        Command::Monitor { target, seconds } => monitor(target, seconds, None, cancel),
        Command::ManualSession(target) => manual_session(target, cancel),
        Command::Jog {
            target,
            speed,
            seconds,
            ..
        } => {
            ensure!(
                speed.is_finite() && speed != 0.,
                "Jog speed must be finite and nonzero"
            );
            ensure!(seconds <= 30., "A CLI jog is limited to 30 seconds");
            monitor(target, Some(seconds), Some(speed), cancel)
        }
        Command::Stop(target) => {
            hardware::disable(&target.config()?)?;
            output(&json!({"id":target.id,"enabled":false}))
        }
        Command::Zero { target, .. } => {
            let (c, _) = detected(&target)?;
            hardware::set_zero(&c)?;
            output(&json!({"id":target.id,"zero_set":true}))
        }
        Command::SetId { target, new_id, .. } => {
            let (c, _) = detected(&target)?;
            hardware::change_id(&c, new_id)?;
            output(&json!({"previous_id":target.id,"id":new_id}))
        }
        Command::Firmware {
            command: FirmwareCommand::Check(target),
        } => {
            let (c, motor) = detected(&target)?;
            let update =
                firmware::available_update(&c.profile.model, motor.firmware.as_deref().unwrap());
            output(&json!({"motor":motor,"update_available":update.is_some(),"release":update}))
        }
        Command::Firmware {
            command: FirmwareCommand::Prepare(target),
        } => {
            let (c, _) = detected(&target)?;
            let prepared = firmware::prepare(&c, |s| eprintln!("{s}"))?;
            output(
                &json!({"model":prepared.release.model,"version":prepared.release.version,
                "current_version":prepared.current_version,"id":prepared.motor_id,
                "uuid":prepared.uuid}),
            )
        }
        Command::Firmware {
            command: FirmwareCommand::Update { target, .. },
        } => {
            let (c, _) = detected(&target)?;
            let prepared = firmware::prepare(&c, |s| eprintln!("{s}"))?;
            ensure!(
                !cancel.load(Ordering::Relaxed),
                "Cancelled before firmware transfer"
            );
            eprintln!(
                "Firmware transfer starting. Keep power on; transfer finishes before exiting."
            );
            let version = firmware::update(&c, &prepared, |fraction, s| {
                eprintln!("{:.0}% {s}", fraction * 100.)
            })?;
            output(&json!({"id":target.id,"firmware":version}))
        }
        Command::Register { command } => match command {
            RegisterCommand::List => output(&registers::CATALOG),
            RegisterCommand::Read { target, index } => {
                let (config, _) = detected(&target)?;
                output(&registers::read(&config, index)?)
            }
            RegisterCommand::Write {
                target,
                index,
                value,
                uuid,
                expected_raw,
                ..
            } => output(&registers::write(
                &detected(&target)?.0,
                index,
                value,
                &uuid,
                &expected_raw,
            )?),
        },
    }
}

fn monitor(
    target: Target,
    seconds: Option<f64>,
    jog: Option<f64>,
    cancel: &AtomicBool,
) -> Result<()> {
    let (c, motor) = detected(&target)?;
    if let Some(speed) = jog {
        ensure!(
            speed.abs() <= manual::max_speed(&c),
            "Jog speed exceeds {:.3} rad/s for {}",
            manual::max_speed(&c),
            c.profile.model
        );
    }
    ensure!(
        !cancel.load(Ordering::Relaxed),
        "Cancelled before monitoring"
    );
    let session = manual::Session::start(c, motor.uuid);
    let started = Instant::now();
    let mut motion_started = None;
    let mut last_print = None;
    let mut was_enabled = false;
    while !cancel.load(Ordering::Relaxed) {
        let state = session.snapshot();
        if let Some(error) = state.error {
            anyhow::bail!(error);
        }
        if let Some(reason) = state.stop_reason {
            anyhow::bail!(reason);
        }
        ensure!(!session.finished(), "Motor monitor stopped");
        if jog.is_some() {
            if state.enabled && !state.preparing {
                motion_started.get_or_insert(Instant::now());
                was_enabled = true;
            }
            ensure!(!was_enabled || state.enabled, "Motor disabled during jog");
            ensure!(
                motion_started.is_some() || started.elapsed() < Duration::from_secs(5),
                "Motor enable timed out"
            );
        }
        let elapsed = motion_started.unwrap_or(started).elapsed();
        if seconds.is_some_and(|s| {
            (jog.is_none() || motion_started.is_some()) && elapsed.as_secs_f64() >= s
        }) {
            break;
        }
        {
            let mut intent = session.intent.lock().unwrap();
            intent.enabled = jog.is_some();
            intent.direction = if motion_started.is_some() {
                jog.map_or(0, |v| if v > 0. { 1 } else { -1 })
            } else {
                0
            };
            if let Some(speed) = jog {
                intent.speed = speed.abs();
            }
            intent.heartbeat = Instant::now();
        }
        if let (Some(fb), Some(at)) = (state.feedback, state.received)
            && last_print
                .is_none_or(|last| at.saturating_duration_since(last) >= Duration::from_millis(100))
        {
            let mut stdout = io::stdout().lock();
            serde_json::to_writer(
                &mut stdout,
                &json!({"t":started.elapsed().as_secs_f64(),"id":target.id,"enabled":state.enabled,
                "position_rad":fb.position,"velocity_rad_s":fb.velocity,"torque_nm":fb.torque,"temperature_c":fb.temperature,"mode":fb.mode,"faults":fb.faults}),
            )?;
            writeln!(stdout)?;
            stdout.flush()?;
            last_print = Some(at);
        }
        thread::sleep(Duration::from_millis(10));
    }
    drop(session); // joins the worker after its stop guard disables the motor
    if io::stderr().is_terminal() {
        eprintln!("Motor disabled.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn requested_gui_config_keeps_advanced_fields_but_checks_motor_identity() {
        let detected = preset("RS-06").unwrap();
        let mut requested = detected.clone();
        requested.train_seconds = 42.;
        requested.validation_seconds = 21.;
        requested.baseline.damping = 0.1;
        let accepted = requested_config(detected.clone(), requested.clone()).unwrap();
        assert_eq!(accepted.train_seconds, 42.);
        assert_eq!(accepted.validation_seconds, 21.);
        assert_eq!(accepted.baseline.damping, 0.1);
        requested.motor_id = 2;
        assert!(requested_config(detected, requested).is_err());
    }

    #[test]
    fn preview_uses_the_same_mixed_trajectory_as_calibration() {
        let config = preset("RS-06").unwrap();
        let preview = preview_config(&config).unwrap();
        assert_eq!(preview["t"].as_array().unwrap().len(), 1201);
        assert_eq!(preview["segments"].as_array().unwrap().len(), 5);
        assert!(
            preview["torque"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_f64().unwrap() != 0.)
        );
    }

    #[test]
    fn register_cli_accepts_negative_offsets_and_integer_flags() {
        for (index, value) in [("0x702B", "-1.25"), ("0x7029", "1")] {
            assert!(
                Cli::try_parse_from([
                    "tool",
                    "register",
                    "write",
                    "--id",
                    "127",
                    "--index",
                    index,
                    "--value",
                    value,
                    "--uuid",
                    "0000000000000000",
                    "--expected-raw",
                    "00000000",
                    "--yes"
                ])
                .is_ok()
            );
        }
    }

    #[test]
    fn motion_requires_explicit_confirmation_and_invalid_commands_never_open_gui() {
        Cli::command().debug_assert();
        for command in [
            vec!["calibrate", "--id", "127"],
            vec!["jog", "--id", "127", "--speed", "0.5", "--seconds", "2"],
            vec!["zero", "--id", "127"],
            vec!["set-id", "--id", "127", "--new-id", "1"],
            vec!["firmware", "update", "--id", "127"],
            vec![
                "register",
                "write",
                "--id",
                "127",
                "--index",
                "0x2012",
                "--value",
                "1",
                "--uuid",
                "0000000000000000",
                "--expected-raw",
                "00000000",
            ],
            vec!["calibrat"],
            vec!["--misspelled"],
            vec!["monitor", "--id", "0"],
            vec!["monitor", "--id", "127", "--seconds", "NaN"],
        ] {
            assert!(
                Cli::try_parse_from(std::iter::once("motor-setup-tool").chain(command)).is_err()
            );
        }
        assert!(
            Cli::try_parse_from([
                "tool",
                "jog",
                "--id",
                "127",
                "--speed",
                "-0.5",
                "--seconds",
                "2",
                "--yes"
            ])
            .is_ok()
        );
        assert!(Cli::try_parse_from(["tool", "--list-can"]).is_ok());
        assert_eq!(register_index("0x2012").unwrap(), 0x2012);
        assert!(register_index("0xzzzz").is_err());
        assert!(
            Cli::try_parse_from(["tool", "--screenshot=/tmp/a.png", "--screenshot-theme=dark"])
                .is_ok()
        );
        for p in Profile::presets() {
            assert!(preset(&p.model).is_ok());
        }
    }
}
