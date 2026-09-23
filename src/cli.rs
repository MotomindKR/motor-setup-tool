//! Headless commands share the GUI's acquisition, manual control, and fitting code.
use crate::{bridge, can_admin, firmware, hardware, manual, pipeline, types::*};
use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use serde_json::json;
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
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

// Keep existing AppImage scripts and screenshot commands working, while making
// unknown arguments an error instead of accidentally opening a GUI.
#[derive(Args)]
struct Legacy {
    #[arg(long, hide = true, group = "legacy_action")]
    install_desktop: bool,
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
    /// Show a model's single calibration preset without connecting hardware.
    Plan {
        #[arg(long)]
        model: String,
    },
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
}

#[derive(Subcommand)]
enum CanCommand {
    /// List physical SocketCAN interfaces without sending frames.
    List,
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
    /// Confirm the motor is secured, shaft clear, and preset limits reviewed.
    #[arg(long, required = true)]
    yes: bool,
}
#[derive(Subcommand)]
enum FirmwareCommand {
    /// Compare installed firmware with the bundled verified release catalog.
    Check(Target),
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
        let width = (percent.clamp(0, 100) / 5) as usize;
        eprintln!("[{}{}] {p}", "=".repeat(width), " ".repeat(20 - width));
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
        Command::Plan { model } => output(&preset(&model)?),
        Command::Calibrate(args) => {
            let (mut config, motor) = detected(&args.target)?;
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
    fn motion_requires_explicit_confirmation_and_invalid_commands_never_open_gui() {
        Cli::command().debug_assert();
        for command in [
            vec!["calibrate", "--id", "127"],
            vec!["jog", "--id", "127", "--speed", "0.5", "--seconds", "2"],
            vec!["zero", "--id", "127"],
            vec!["set-id", "--id", "127", "--new-id", "1"],
            vec!["firmware", "update", "--id", "127"],
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
        assert!(
            Cli::try_parse_from(["tool", "--screenshot=/tmp/a.png", "--screenshot-theme=dark"])
                .is_ok()
        );
        for p in Profile::presets() {
            assert!(preset(&p.model).is_ok());
        }
    }
}
