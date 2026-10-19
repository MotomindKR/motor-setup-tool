mod app;
mod bridge;
mod can_admin;
mod cli;
mod desktop;
mod encoder;
mod engine;
mod experiment;
mod firmware;
mod fit;
mod hardware;
mod manual;
mod paths;
mod pipeline;
mod protocol;
mod registers;
mod theme;
mod types;

fn main() -> anyhow::Result<()> {
    if cli::dispatch()? {
        return Ok(());
    }
    if std::env::args().any(|a| a == "--version") {
        println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if std::env::args().any(|a| a == "--list-can") {
        println!(
            "{}",
            serde_json::to_string_pretty(&hardware::available_interfaces()?)?
        );
        return Ok(());
    }
    if std::env::args().any(|a| a == "--self-check") {
        // No CAN socket is opened and no motor command is sent.
        engine::self_check()?;
        let run = bridge::new_run_dir()?;
        let probe = run.join("package-check.json");
        bridge::write_json(&probe, &serde_json::json!({"mujoco": engine::VERSION}))?;
        let _: serde_json::Value = bridge::read_json(&probe)?;
        std::fs::remove_file(probe)?;
        std::fs::remove_dir(run)?;
        println!(
            "{}",
            serde_json::json!({
                "name": env!("CARGO_PKG_NAME"),
                "version": env!("CARGO_PKG_VERSION"), "mujoco": engine::VERSION,
                "data": paths::data_dir()?, "cache": paths::cache_dir()?,
                "locks": paths::lock_dir()?, "theme": format!("{:?}", theme::desktop_theme()),
                "interfaces": hardware::available_interfaces()?
            })
        );
        return Ok(());
    }
    if let Some(interface) =
        std::env::args().find_map(|a| a.strip_prefix("--update-firmware=").map(str::to_owned))
    {
        let motor_id = std::env::args()
            .find_map(|a| a.strip_prefix("--motor-id=").map(str::to_owned))
            .ok_or_else(|| anyhow::anyhow!("--motor-id is required"))?
            .parse::<u8>()?;
        let model = std::env::args()
            .find_map(|a| a.strip_prefix("--model=").map(str::to_owned))
            .ok_or_else(|| anyhow::anyhow!("--model is required, e.g. RS-00"))?;
        let profile = types::Profile::presets()
            .into_iter()
            .find(|p| p.model == model)
            .ok_or_else(|| anyhow::anyhow!("Unknown motor model"))?;
        let config = types::Config {
            interface,
            motor_id,
            profile,
            ..Default::default()
        };
        let prepared = firmware::prepare(&config, |s| println!("{s}"))?;
        println!(
            "{} ID {}: {} -> {}",
            model, motor_id, prepared.current_version, prepared.release.version
        );
        firmware::update(&config, &prepared, |fraction, s| {
            println!("{:.0}% {s}", fraction * 100.)
        })?;
        return Ok(());
    }
    if let Some(interface) =
        std::env::args().find_map(|a| a.strip_prefix("--firmware=").map(str::to_owned))
    {
        let motor_id = std::env::args()
            .find_map(|a| a.strip_prefix("--motor-id=").map(str::to_owned))
            .unwrap_or_else(|| "1".into())
            .parse::<u8>()?;
        let config = types::Config {
            interface,
            motor_id,
            ..Default::default()
        };
        config.validate()?;
        let version = hardware::read_firmware(&config)?;
        println!(
            "Motor {motor_id}: firmware {version}; firmware family {}; motor remains stopped",
            protocol::firmware_model(&version).unwrap_or("unknown".into())
        );
        return Ok(());
    }
    if let Some(interface) =
        std::env::args().find_map(|a| a.strip_prefix("--scan=").map(str::to_owned))
    {
        let config = types::Config {
            interface,
            ..Default::default()
        };
        let found = hardware::scan(&config, &std::sync::atomic::AtomicBool::new(false), |s| {
            println!("{s}")
        })?;
        println!("{}", serde_json::to_string_pretty(&found)?);
        return Ok(());
    }
    if let Some(path) =
        std::env::args().find_map(|a| a.strip_prefix("--analyze=").map(str::to_owned))
    {
        let report = pipeline::analyze(
            std::path::Path::new(&path),
            &std::sync::atomic::AtomicBool::new(false),
            |s| println!("{s}"),
        )?;
        println!("{}", serde_json::to_string_pretty(&report.fitted)?);
        println!("Accepted: {}", report.accepted);
        return Ok(());
    }
    let icon = image::load_from_memory(desktop::WINDOW_ICON)?.into_rgba8();
    let options = eframe::NativeOptions {
        persist_window: !std::env::args().any(|a| a.starts_with("--screenshot=")),
        // Keep window/layout preferences across the package and desktop-ID rename.
        persistence_path: eframe::storage_dir("MotoMind · Motor Calibration")
            .map(|directory| directory.join("app.ron")),
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Motor Setup Tool · Motomind")
            .with_app_id(desktop::APP_ID)
            .with_icon(eframe::egui::IconData {
                width: icon.width(),
                height: icon.height(),
                rgba: icon.into_raw(),
            })
            .with_inner_size([1320., 940.])
            .with_min_inner_size([1000., 700.]),
        ..Default::default()
    };
    eframe::run_native(
        "Motor Setup Tool",
        options,
        Box::new(|cc| Ok(Box::new(app::CalibrationApp::new(cc)))),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))
}
