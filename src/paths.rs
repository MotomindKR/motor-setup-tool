//! One identity across development builds, AppImages and future packages.
use anyhow::{Context, Result};
use std::path::PathBuf;

// Stable on-disk identity from v0.1.0. In particular, old and new binaries must
// share CAN lock inodes; changing this when renaming the package could allow
// both versions to control the same motor concurrently.
const APP: &str = "motomind-motor-calib";

pub fn data_dir() -> Result<PathBuf> {
    Ok(dirs::data_dir()
        .context("Cannot locate the user data directory")?
        .join(APP))
}
pub fn cache_dir() -> Result<PathBuf> {
    Ok(dirs::cache_dir()
        .context("Cannot locate the user cache directory")?
        .join(APP))
}
pub fn lock_dir() -> Result<PathBuf> {
    // Deliberately persistent: a GUI and an SSH session may have different
    // XDG_RUNTIME_DIR values, but must still contend for the same lock inode.
    // Lock files are never unlinked; the OS releases the lock on process exit.
    let directory = data_dir()?.join("can-locks");
    std::fs::create_dir_all(&directory)?;
    Ok(directory)
}
