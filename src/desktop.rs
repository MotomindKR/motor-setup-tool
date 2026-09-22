//! Install AppImage assets outside its temporary mount so Wayland desktops can
//! resolve the window's application ID to a launcher and icon.
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

pub const APP_ID: &str = "com.motomind.MotorSetup";
pub const WINDOW_ICON: &[u8] = include_bytes!("../assets/icons/256.png");

const ICONS: &[(u32, &[u8])] = &[
    (16, include_bytes!("../assets/icons/16.png")),
    (24, include_bytes!("../assets/icons/24.png")),
    (32, include_bytes!("../assets/icons/32.png")),
    (48, include_bytes!("../assets/icons/48.png")),
    (64, include_bytes!("../assets/icons/64.png")),
    (128, include_bytes!("../assets/icons/128.png")),
    (256, WINDOW_ICON),
    (512, include_bytes!("../assets/icons/512.png")),
];

pub fn install_appimage() -> Result<Option<PathBuf>> {
    let Some(appimage) = std::env::var_os("APPIMAGE") else {
        return Ok(None);
    };
    let data = dirs::data_dir().context("Cannot locate the desktop data directory")?;
    install(Path::new(&appimage), &data).map(Some)
}

fn install(appimage: &Path, data: &Path) -> Result<PathBuf> {
    let appimage = appimage
        .canonicalize()
        .context("Locate the AppImage file")?;
    let metadata = appimage.metadata()?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
        "The AppImage must be an executable file"
    );
    let executable = exec_value(&appimage)?;
    let theme = data.join("icons/hicolor");
    let icon = theme.join(format!("256x256/apps/{APP_ID}.png"));
    let icon_value = string_value(&icon)?;
    for &(size, bytes) in ICONS {
        write_changed(
            &theme.join(format!("{size}x{size}/apps/{APP_ID}.png")),
            bytes,
        )?;
    }
    write_changed(
        &theme.join(format!("scalable/apps/{APP_ID}.svg")),
        include_bytes!("../assets/motor-setup-tool.svg"),
    )?;
    let mut entry = String::new();
    for line in include_str!("../packaging/com.motomind.MotorSetup.desktop").lines() {
        if line.starts_with("Exec=") {
            // GLib checks argv[0] before expanding %% field escapes. A fixed
            // executable keeps AppImages with literal % in their name launchable.
            // env passes the path as one argument; no shell evaluates it.
            entry.push_str(&format!("Exec=/usr/bin/env -- {executable}\n"));
        } else if line.starts_with("Icon=") {
            // An absolute icon path also works without a host icon-cache tool.
            entry.push_str(&format!("Icon={icon_value}\n"));
        } else {
            entry.push_str(line);
            entry.push('\n');
        }
    }
    let launcher = data.join(format!("applications/{APP_ID}.desktop"));
    // Install last: the shell must never see a launcher pointing to missing icons.
    write_changed(&launcher, entry.as_bytes())?;
    Ok(launcher)
}

fn path_text(path: &Path) -> Result<&str> {
    let text = path.to_str().context("Desktop paths must be valid UTF-8")?;
    ensure!(
        !text.chars().any(char::is_control),
        "Desktop paths cannot contain control characters"
    );
    Ok(text)
}

fn string_value(path: &Path) -> Result<String> {
    Ok(path_text(path)?.replace('\\', "\\\\"))
}

fn exec_value(path: &Path) -> Result<String> {
    let text = path_text(path)?;
    ensure!(
        !text.contains('='),
        "Desktop executable paths cannot contain ="
    );
    // Desktop Entry parsing first unescapes strings, then removes Exec quoting,
    // then expands field codes. These are not shell-quoting rules.
    let mut quoted = String::from("\"");
    for c in text.chars() {
        match c {
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

fn write_changed(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::read(path).is_ok_and(|current| current == bytes) {
        return Ok(());
    }
    fs::create_dir_all(
        path.parent()
            .context("Desktop asset needs a parent directory")?,
    )?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = file
        .write_all(bytes)
        .and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.with_context(|| format!("Install desktop asset {}", path.display()))
}
