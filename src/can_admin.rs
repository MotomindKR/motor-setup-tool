//! Elevate only the host's ip command; the GUI and motor control stay unprivileged.
use crate::hardware;
use anyhow::{Context, Result, bail, ensure};
use std::{
    io::IsTerminal,
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum Auth {
    /// Use the desktop's system authentication dialog.
    Polkit,
    /// Use sudo's terminal password prompt (noninteractive without a TTY).
    Sudo,
    /// Run ip directly, for an already privileged shell.
    Direct,
}

fn host_tool(paths: &[&'static str], description: &str) -> Result<&'static str> {
    paths
        .iter()
        .copied()
        .find(|p| Path::new(p).is_file())
        .with_context(|| format!("{description} is not installed on this computer"))
}

pub fn up(interface: &str, restart: bool, auth: Auth, cancel: &AtomicBool) -> Result<()> {
    let _lock = hardware::lock_interface(interface)?;
    let bus = hardware::available_interfaces()?
        .into_iter()
        .find(|b| b.name == interface)
        .context("Select an available physical CAN interface")?;
    if bus.ready() && !restart {
        ensure!(
            bus.bitrate == Some(1_000_000),
            "{interface} uses a different bitrate. Use CAN restart to configure 1 Mbps"
        );
        return Ok(());
    }
    let ip = host_tool(
        &["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"],
        "iproute2",
    )?;
    if bus.up {
        ensure!(
            restart,
            "{interface} is {}. Use CAN restart to reset it",
            bus.state
        );
        invoke(ip, &["link", "set", "dev", interface, "down"], auth, cancel)?;
    }
    invoke(
        ip,
        &[
            "link", "set", "dev", interface, "up", "type", "can", "bitrate", "1000000",
        ],
        auth,
        cancel,
    )?;
    ensure!(
        hardware::available_interfaces()?
            .iter()
            .any(|b| b.name == interface && b.ready() && b.bitrate == Some(1_000_000)),
        "{interface} did not become ready. Check the adapter and CAN wiring"
    );
    Ok(())
}

fn invoke(ip: &str, arguments: &[&str], auth: Auth, cancel: &AtomicBool) -> Result<()> {
    let mut command = match auth {
        Auth::Polkit => {
            let pkexec = host_tool(&["/usr/bin/pkexec", "/bin/pkexec"], "PolicyKit (pkexec)")?;
            let mut c = Command::new(pkexec);
            c.args(["--disable-internal-agent", ip])
                .stdin(Stdio::null());
            c
        }
        Auth::Sudo => {
            let sudo = host_tool(&["/usr/bin/sudo", "/bin/sudo"], "sudo")?;
            let mut c = Command::new(sudo);
            if !std::io::stdin().is_terminal() {
                c.arg("-n");
            }
            c.arg(ip).stdin(Stdio::inherit());
            c
        }
        Auth::Direct => Command::new(ip),
    };
    // Do not pass development or packaged library overrides to system programs.
    command
        .args(arguments)
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if matches!(auth, Auth::Sudo) {
        command.stderr(Stdio::inherit());
    }
    wait(command, cancel)
}

fn wait(mut command: Command, cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "CAN setup cancelled");
    let mut child = command
        .spawn()
        .context("Start system authentication for CAN setup")?;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("CAN setup cancelled");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        return Ok(());
    }
    match output.status.code() {
        Some(126) => bail!("Authentication cancelled. The CAN bus was not brought up"),
        Some(127) => {
            bail!("Authentication was denied or no system authentication agent is available")
        }
        _ => {
            let detail = String::from_utf8_lossy(&output.stderr);
            bail!(
                "CAN setup failed. {}",
                if detail.trim().is_empty() {
                    "Check the authentication prompt and adapter status."
                } else {
                    detail.trim()
                }
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_ends_pending_authentication() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let signal_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            signal.store(true, Ordering::Relaxed);
        });
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("5");
        let started = std::time::Instant::now();
        assert!(
            wait(cmd, &cancel)
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
        signal_thread.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn authentication_cancel_and_failure_are_not_reported_as_success() {
        for (code, expected) in [(126, "cancelled"), (127, "denied"), (2, "failed")] {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", &format!("exit {code}")]);
            assert!(
                wait(cmd, &AtomicBool::new(false))
                    .unwrap_err()
                    .to_string()
                    .contains(expected)
            );
        }
        assert!(wait(Command::new("/bin/true"), &AtomicBool::new(false)).is_ok());
        assert!(wait(Command::new("/bin/true"), &AtomicBool::new(true)).is_err());
    }
}
