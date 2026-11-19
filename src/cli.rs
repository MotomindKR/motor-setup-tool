//! Headless commands share the GUI's acquisition, manual control, and fitting code.
use crate::{
    bridge, can_admin, engine, experiment, firmware, hardware, manual, paths, pipeline, registers,
    types::*,
};
use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    cell::Cell,
    io::{self, BufRead, IsTerminal, Read, Write},
    path::PathBuf,
    sync::{
        Arc,
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
    long_about = "Motomind motor calibration and setup. Open the Electron app for the desktop interface.\nCommands run without a display. Results go to stdout as JSON; progress goes to stderr.",
    arg_required_else_help = true
)]
struct Cli {
    #[arg(long, hide = true)]
    desktop: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check the bundled MuJoCo runtime and application data directories.
    SelfCheck,
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
        /// Include input limits and the model’s register catalog alongside the preset.
        #[arg(long)]
        setup: bool,
    },
    /// Return the current calibration preview without opening hardware.
    #[command(hide = true)]
    Preview,
    /// Record and fit a real motor; writes the same artifacts as the GUI.
    Calibrate(Calibrate),
    /// Refit a saved real recording; replaces analysis artifacts.
    Analyze { directory: PathBuf },
    /// Hold a recording for a desktop file operation until its input pipe closes.
    #[command(hide = true)]
    LockRecording { directory: PathBuf },
    /// Stream disabled-motor feedback as JSON lines until Ctrl+C or timeout.
    Monitor {
        #[command(flatten)]
        target: Target,
        #[arg(long, value_parser = seconds)]
        seconds: Option<f64>,
    },
    /// Stream a monitored manual session controlled by JSON intent lines on stdin.
    #[command(hide = true)]
    ManualSession(SelectedTarget),
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
        target: SelectedTarget,
        #[arg(long, required = true)]
        yes: bool,
    },
    /// Change CAN ID, checking for collisions and verifying motor identity.
    SetId {
        #[command(flatten)]
        target: SelectedTarget,
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
    /// List CAN register access and persistence for a motor model.
    List {
        #[arg(long, default_value = "RS-00")]
        model: String,
    },
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
struct SelectedTarget {
    #[command(flatten)]
    target: Target,
    /// Require the scanned actuator's 16-digit hexadecimal UUID.
    #[arg(long, value_parser = |s: &str| crate::protocol::parse_hex::<8>(s, "Motor UUID"))]
    expected_uuid: Option<[u8; 8]>,
}

impl SelectedTarget {
    fn detect(&self) -> Result<(Config, hardware::DiscoveredMotor)> {
        let (config, motor) = detected(&self.target)?;
        if let Some(expected) = self.expected_uuid {
            ensure!(
                motor.uuid == expected,
                "Motor UUID at this ID changed; scan again"
            );
        }
        Ok((config, motor))
    }
}

#[derive(Args)]
struct Calibrate {
    #[command(flatten)]
    target: SelectedTarget,
    /// New recording directory; an existing directory is never overwritten.
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long, value_parser = seconds)]
    train_seconds: Option<f64>,
    #[arg(long, value_parser = seconds)]
    validation_seconds: Option<f64>,
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
        /// Reuse the motor identity and versions returned by firmware prepare.
        #[arg(long, hide = true, value_parser = |s: &str| serde_json::from_str::<firmware::Prepared>(s))]
        prepared: Option<firmware::Prepared>,
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

fn output_line(value: &impl Serialize) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

struct JobOutput<'a> {
    desktop: bool,
    cancel: &'a AtomicBool,
    last_progress: Cell<Option<(WorkPhase, i32)>>,
}
impl JobOutput<'_> {
    fn result(&self, value: &impl Serialize) -> Result<()> {
        if self.desktop {
            return output_line(&json!({"type":"result","value":value}));
        }
        let mut out = io::stdout().lock();
        serde_json::to_writer_pretty(&mut out, value)?;
        writeln!(out)?;
        Ok(())
    }

    fn status(&self, value: &impl Serialize) -> Result<()> {
        if self.desktop {
            output_line(&json!({"type":"manualStatus","value":value}))
        } else {
            output_line(value)
        }
    }

    fn end_stream(&self) -> Result<()> {
        if self.desktop {
            self.result(&())
        } else {
            Ok(())
        }
    }

    fn progress(&self, message: &str, percent: Option<i32>) {
        if self.desktop {
            if output_line(&json!({"type":"progress","message":message,"percent":percent})).is_err()
            {
                self.cancel.store(true, Ordering::Relaxed);
            }
        } else if let Some(percent) = percent {
            eprintln!("{percent}% {message}");
        } else {
            eprintln!("{message}");
        }
    }

    fn show(&self, p: WorkProgress) {
        let percent = (p.fraction * 100.).floor() as i32;
        if self.last_progress.replace(Some((p.phase, percent))) == Some((p.phase, percent)) {
            return;
        }
        if self.desktop {
            self.progress(&p.label, Some(percent));
        } else if io::stderr().is_terminal() {
            let width = (percent.clamp(0, 100) / 5) as usize;
            eprintln!("[{}{}] {p}", "=".repeat(width), " ".repeat(20 - width));
        } else {
            eprintln!("{p}");
        }
    }
}

fn validate_measurement_config(requested: &Config, preset: &Config) -> Result<()> {
    ensure!(
        requested.profile == preset.profile,
        "Motor wire profile changed; scan again"
    );
    ensure!(
        requested.experiment == preset.experiment
            && requested.excitation_revision == preset.excitation_revision
            && requested.baseline.static_friction == preset.baseline.static_friction,
        "Use the current model preset for new measurements"
    );
    requested.validate()
}

fn requested_config(detected: &Config, requested: Config) -> Result<Config> {
    ensure!(
        requested.interface == detected.interface
            && requested.motor_id == detected.motor_id
            && requested.host_id == detected.host_id,
        "Motor identity changed; scan again"
    );
    validate_measurement_config(&requested, detected)?;
    Ok(requested)
}

fn preview_config(c: &Config) -> Result<serde_json::Value> {
    validate_measurement_config(c, &Config::preset(&c.profile.model)?)?;
    let segments = experiment::plan(c, false);
    let samples = 1200;
    let mut t = Vec::with_capacity(samples + 1);
    let mut velocity = Vec::with_capacity(samples + 1);
    let mut torque = Vec::with_capacity(samples + 1);
    for index in 0..=samples {
        let time = index as f64 * c.train_seconds / samples as f64;
        let (v, q) = experiment::preview(c, time, &segments);
        t.push(time);
        velocity.push(v);
        torque.push(q);
    }
    Ok(json!({"spec":c.profile.spec(),"segments":segments,
        "t":t,"velocity":velocity,"torque":torque}))
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

fn manual_session(selected: SelectedTarget, out: &JobOutput<'_>) -> Result<()> {
    let cancel = out.cancel;
    let mut first = String::new();
    ensure!(
        io::stdin().read_line(&mut first)? > 0,
        "Manual session needs a configuration"
    );
    let requested: Config = serde_json::from_str(&first).context("Invalid manual configuration")?;
    let (detected, motor) = selected.detect()?;
    let target = selected.target;
    let config = requested_config(&detected, requested)?;
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
        crate::cancel::check(cancel)?;
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
                    return out.end_stream();
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
            out.status(&json!({"t":started.elapsed().as_secs_f64(),"id":target.id,
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
}

fn detected(target: &Target) -> Result<(Config, hardware::DiscoveredMotor)> {
    let base = target.config()?;
    let motor = hardware::inspect(&base)?;
    let mut config = Config::preset(
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

pub fn dispatch() -> Result<()> {
    let Cli { desktop, command } = Cli::parse();
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))?;
    let mut desktop_config = None;
    if desktop && !matches!(command, Command::ManualSession(_) | Command::Preview) {
        if matches!(&command, Command::Calibrate(args) if args.config_stdin) {
            let mut line = String::new();
            io::stdin().read_line(&mut line)?;
            desktop_config =
                Some(serde_json::from_str(&line).context("Invalid calibration configuration")?);
        }
        // Electron keeps stdin open for the lifetime of the job. EOF also covers a lost parent.
        let flag = Arc::clone(&cancel);
        thread::spawn(move || {
            let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
            flag.store(true, Ordering::Relaxed);
        });
    }
    let out = JobOutput {
        desktop,
        cancel: &cancel,
        last_progress: Cell::new(None),
    };
    let result = execute(command, &out, desktop_config);
    match result {
        Err(error) if desktop && error.is::<crate::cancel::Cancelled>() => {
            out.result(&json!({"cancelled":true}))
        }
        other => other,
    }
}

fn execute(command: Command, out: &JobOutput<'_>, desktop_config: Option<Config>) -> Result<()> {
    let cancel = out.cancel;
    match command {
        Command::SelfCheck => {
            engine::self_check()?;
            let run = bridge::new_run_dir()?;
            let probe = run.join("package-check.json");
            bridge::write_json(&probe, &json!({"mujoco": mujoco_rs::mujoco_version()}))?;
            let _: serde_json::Value = bridge::read_json(&probe)?;
            std::fs::remove_file(probe)?;
            std::fs::remove_dir(run)?;
            out.result(&json!({
                "name": env!("CARGO_PKG_NAME"), "version": env!("CARGO_PKG_VERSION"),
                "mujoco": mujoco_rs::mujoco_version(), "data": paths::data_dir()?,
                "cache": paths::cache_dir()?, "locks": paths::lock_dir()?,
                "interfaces": hardware::available_interfaces()?
            }))
        }
        Command::Can { command } => {
            match command {
                CanCommand::List => {}
                CanCommand::UsbList => return out.result(&hardware::available_usb_adapters()?),
                CanCommand::Up(args) => can_admin::up(&args.interface, false, args.auth, cancel)?,
                CanCommand::Restart(args) => {
                    can_admin::up(&args.interface, true, args.auth, cancel)?
                }
            }
            out.result(&hardware::available_interfaces()?)
        }
        Command::Scan(args) => {
            let c = Config {
                interface: args.can,
                host_id: args.host_id,
                ..Default::default()
            };
            out.result(&hardware::scan(&c, cancel, |p| out.show(p))?)
        }
        Command::Info(target) => out.result(&hardware::inspect(&target.config()?)?),
        Command::Latency(target) => {
            let (config, _) = detected(&target)?;
            out.result(&hardware::measure_feedback_latency(&config, cancel)?)
        }
        Command::Plan { model, setup } => {
            let preset = Config::preset(&model)?;
            if setup {
                let limits: std::collections::BTreeMap<_, _> = preset
                    .input_fields()?
                    .map(|(key, _, range)| (key, range))
                    .collect();
                out.result(&json!({ "preset": preset, "limits": limits, "registers": registers::catalog(&model)? }))
            } else {
                out.result(&preset)
            }
        }
        Command::Preview => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            let config: Config =
                serde_json::from_str(&input).context("Invalid preview configuration")?;
            out.result(&preview_config(&config)?)
        }
        Command::Calibrate(args) => {
            let (mut config, motor) = args.target.detect()?;
            if args.config_stdin {
                let requested = match desktop_config {
                    Some(config) => config,
                    None => serde_json::from_reader(io::stdin().lock())
                        .context("Invalid calibration configuration")?,
                };
                config = requested_config(&config, requested)?;
            } else {
                config.train_seconds = args.train_seconds.unwrap_or(config.train_seconds);
                config.validation_seconds =
                    args.validation_seconds.unwrap_or(config.validation_seconds);
                config.torque_limit = args.torque_limit.unwrap_or(config.torque_limit);
                config.speed_limit = args.speed_limit.unwrap_or(config.speed_limit);
                config.travel_limit = args.travel_limit.unwrap_or(config.travel_limit);
                config.validate()?;
            }
            crate::cancel::check(cancel)?;
            let dir = if let Some(dir) = args.output {
                std::fs::create_dir(&dir)
                    .context("Choose a new recording directory with an existing parent")?;
                dir
            } else {
                bridge::new_run_dir()?
            };
            let _recording = bridge::lock_recording(&dir)?;
            bridge::write_json(&dir.join("config.json"), &config)?;
            if out.desktop {
                output_line(&json!({"type":"recordingCreated","directory":dir}))?;
            } else {
                eprintln!(
                    "{} · ID {} · torque {:.3} Nm · speed {:.3} rad/s · travel ±{:.3} rad",
                    config.profile.model,
                    motor.id,
                    config.torque_limit,
                    config.speed_limit,
                    config.travel_limit
                );
                eprintln!("Recording to {}. Ctrl+C stops the motor.", dir.display());
            }
            if let Err(e) = hardware::acquire(&config, motor.uuid, &dir, cancel, |p| out.show(p)) {
                let _ =
                    bridge::write_json(&dir.join("error.json"), &json!({"error":format!("{e:#}")}));
                return Err(e);
            }
            let report = pipeline::analyze(&dir, cancel, |p| out.show(p))?;
            out.result(
                &json!({"directory":dir,"accepted":report.accepted,"fitted":report.fitted,"warnings":report.warnings}),
            )
        }
        Command::Analyze { directory } => {
            let _recording = bridge::lock_recording(&directory)?;
            let report = pipeline::analyze(&directory, cancel, |p| out.show(p))?;
            if out.desktop {
                out.result(&json!({"directory":directory,"accepted":report.accepted}))
            } else {
                out.result(&report)
            }
        }
        Command::LockRecording { directory } => {
            ensure!(!out.desktop, "Use lock-recording directly");
            let _recording = bridge::lock_recording(&directory)?;
            let mut stdout = io::stdout().lock();
            writeln!(stdout, "locked")?;
            stdout.flush()?;
            io::copy(&mut io::stdin().lock(), &mut io::sink())?;
            Ok(())
        }
        Command::Monitor { target, seconds } => monitor(target, seconds, None, out),
        Command::ManualSession(target) => manual_session(target, out),
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
            monitor(target, Some(seconds), Some(speed), out)
        }
        Command::Stop(target) => {
            hardware::disable(&target.config()?)?;
            out.result(&json!({"id":target.id,"enabled":false}))
        }
        Command::Zero { target, .. } => {
            let (c, motor) = target.detect()?;
            crate::cancel::check(cancel)?;
            hardware::set_zero(&c, motor.uuid)?;
            out.result(&json!({"id":motor.id,"zero_set":true}))
        }
        Command::SetId { target, new_id, .. } => {
            let (c, motor) = target.detect()?;
            crate::cancel::check(cancel)?;
            hardware::change_id(&c, motor.uuid, new_id)?;
            out.result(&json!({"previous_id":motor.id,"id":new_id}))
        }
        Command::Firmware {
            command: FirmwareCommand::Check(target),
        } => {
            let (c, motor) = detected(&target)?;
            let update =
                firmware::available_update(&c.profile.model, motor.firmware.as_deref().unwrap());
            out.result(&json!({"motor":motor,"update_available":update.is_some(),"release":update}))
        }
        Command::Firmware {
            command: FirmwareCommand::Prepare(target),
        } => {
            let (c, motor) = detected(&target)?;
            let prepared = firmware::prepare(&c, motor, cancel, |s| out.progress(&s, None))?;
            out.result(&prepared)
        }
        Command::Firmware {
            command: FirmwareCommand::Update {
                target, prepared, ..
            },
        } => {
            ensure!(
                !out.desktop || prepared.is_some(),
                "Prepare and confirm this motor’s firmware first"
            );
            let (c, motor) = detected(&target)?;
            let prepared = match prepared {
                Some(prepared) => prepared,
                None => firmware::prepare(&c, motor, cancel, |s| out.progress(&s, None))?,
            };
            crate::cancel::check(cancel)?;
            out.progress(
                "Firmware transfer starting. Keep power on; transfer finishes before exiting.",
                None,
            );
            let version = firmware::update(&c, &prepared, cancel, |fraction, s| {
                out.progress(&s, Some((fraction * 100.).round() as i32))
            })?;
            out.result(&json!({"id":target.id,"firmware":version}))
        }
        Command::Register { command } => match command {
            RegisterCommand::List { model } => out.result(&registers::catalog(&model)?),
            RegisterCommand::Read { target, index } => {
                let (config, _) = detected(&target)?;
                out.result(&registers::read(&config, index)?)
            }
            RegisterCommand::Write {
                target,
                index,
                value,
                uuid,
                expected_raw,
                ..
            } => {
                let (config, _) = detected(&target)?;
                crate::cancel::check(cancel)?;
                out.result(&registers::write(
                    &config,
                    index,
                    value,
                    &uuid,
                    &expected_raw,
                )?)
            }
        },
    }
}

fn monitor(
    target: Target,
    seconds: Option<f64>,
    jog: Option<f64>,
    out: &JobOutput<'_>,
) -> Result<()> {
    let cancel = out.cancel;
    let (c, motor) = detected(&target)?;
    if let Some(speed) = jog {
        ensure!(
            speed.abs() <= manual::max_speed(&c),
            "Jog speed exceeds {:.3} rad/s for {}",
            manual::max_speed(&c),
            c.profile.model
        );
    }
    crate::cancel::check(cancel)?;
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
            out.status(&json!({"t":started.elapsed().as_secs_f64(),"id":target.id,"enabled":state.enabled,
                "position_rad":fb.position,"velocity_rad_s":fb.velocity,"torque_nm":fb.torque,"temperature_c":fb.temperature,"mode":fb.mode,"faults":fb.faults}),
            )?;
            last_print = Some(at);
        }
        thread::sleep(Duration::from_millis(10));
    }
    drop(session); // joins the worker after its stop guard disables the motor
    if !out.desktop && io::stderr().is_terminal() {
        eprintln!("Motor disabled.");
    }
    crate::cancel::check(cancel)?;
    out.end_stream()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    fn parse(args: &str) -> clap::error::Result<Cli> {
        Cli::try_parse_from(std::iter::once("tool").chain(args.split_ascii_whitespace()))
    }

    #[test]
    fn desktop_measurements_accept_the_offered_limits_and_user_edits() {
        for profile in Profile::presets() {
            let detected = Config::preset(&profile.model).unwrap();
            let mut requested = serde_json::to_value(&detected).unwrap();
            for (field, _, [_, maximum]) in detected.input_fields().unwrap() {
                if matches!(field, "torque_limit" | "speed_limit" | "travel_limit") {
                    requested[field] = json!(maximum);
                }
            }
            requested["train_seconds"] = json!(42.);
            requested["baseline"]["damping"] = json!(0.1);
            let edited = serde_json::from_str(&requested.to_string()).unwrap();
            let accepted =
                serde_json::to_value(requested_config(&detected, edited).unwrap()).unwrap();
            for field in [
                "/torque_limit",
                "/speed_limit",
                "/travel_limit",
                "/train_seconds",
                "/baseline/damping",
            ] {
                assert_eq!(accepted.pointer(field), requested.pointer(field));
            }
        }
    }

    #[test]
    fn a_measurement_must_match_the_reviewed_motor_and_suite() {
        let detected = Config::preset("RS-06").unwrap();
        let mut requested = detected.clone();
        requested.motor_id = 2;
        assert!(requested_config(&detected, requested).is_err());
        let mut requested = detected.clone();
        requested.excitation_revision += 1;
        assert!(preview_config(&requested).is_err());
        assert!(requested_config(&detected, requested).is_err());
    }

    #[test]
    fn preview_uses_the_same_mixed_trajectory_as_calibration() {
        let config = Config::preset("RS-06").unwrap();
        let preview = preview_config(&config).unwrap();
        let times = preview["t"].as_array().unwrap();
        assert_eq!(times.first().unwrap(), 0.);
        assert_eq!(times.last().unwrap(), config.train_seconds);
        assert_eq!(times.len(), preview["velocity"].as_array().unwrap().len());
        assert_eq!(times.len(), preview["torque"].as_array().unwrap().len());
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
            let command = format!(
                "register write --id 127 --index {index} --value {value} --uuid 0000000000000000 --expected-raw 00000000 --yes"
            );
            assert!(parse(&command).is_ok(), "{command}");
        }
    }

    #[test]
    fn motor_changes_require_explicit_confirmation() {
        for command in [
            "calibrate --id 127",
            "jog --id 127 --speed -0.5 --seconds 2",
            "zero --id 127",
            "set-id --id 127 --new-id 1",
            "firmware update --id 127",
            "register write --id 127 --index 0x7010 --value 1 --uuid 0000000000000000 --expected-raw 00000000",
        ] {
            assert_eq!(
                parse(command).err().unwrap().kind(),
                ErrorKind::MissingRequiredArgument,
                "{command}"
            );
            assert!(parse(&format!("{command} --yes")).is_ok(), "{command}");
        }
    }

    #[test]
    fn cli_rejects_invalid_input_and_shows_help_without_a_command() {
        for command in [
            "calibrat",
            "--misspelled",
            "monitor --id 0",
            "monitor --id 127 --seconds NaN",
            "register read --id 127 --index 0xzzzz",
        ] {
            assert!(parse(command).is_err(), "{command}");
        }
        assert_eq!(
            parse("").err().unwrap().kind(),
            ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        );
    }
}
