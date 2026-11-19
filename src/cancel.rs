use std::{
    fmt,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug)]
pub struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Operation cancelled")
    }
}
impl std::error::Error for Cancelled {}

pub fn check(flag: &AtomicBool) -> anyhow::Result<()> {
    if flag.load(Ordering::Relaxed) {
        return Err(Cancelled.into());
    }
    Ok(())
}
