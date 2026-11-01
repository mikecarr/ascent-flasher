//! Finding Ascent devices: VID filter plus a FIND_DEVICE probe (nothing else).

use crate::link::{Connector, PortInfo};
use crate::payload::DeviceInfo;
use crate::session::{AckTiming, Session, SessionError};
use crate::upgrade::UpgradeError;
use std::time::{Duration, Instant};

/// USB vendor IDs that may be an Ascent device.
///
/// 0x1D7C–0x1D7F are deliberately excluded: this mirrors the original
/// tool's VID table, which jumps from 0x1D7B (VRX EX2) to 0x1D80 (JoyStick)
/// with no entries in between (docs/REVERSE_ENGINEERING.md §2).
pub fn is_candidate(vid: u16) -> bool {
    matches!(vid, 0x1D6B..=0x1D7B | 0x1D80..=0x1D84)
}

/// How long to wait after a REBOOT before re-finding the device, by USB VID.
pub fn reopen_delay_for_vid(vid: u16) -> Duration {
    let ms = match vid {
        0x1D6B..=0x1D74 => 8000,
        0x1D75 => 9500,
        0x1D76 => 11500,
        0x1D77..=0x1D79 => 12000,
        0x1D7A..=0x1D7B => 10000,
        0x1D80 => 8000,
        0x1D81..=0x1D84 => 9500,
        _ => 8000,
    };
    Duration::from_millis(ms)
}

/// Whether `p` looks like the same device as `like`: same VID/PID, and the
/// same serial when both report one.
fn same_device(p: &PortInfo, like: &PortInfo) -> bool {
    p.vid == like.vid
        && p.pid == like.pid
        && match (&p.serial, &like.serial) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
}

/// Wait `delay`, then repeatedly look for a port matching `like` (the path
/// may have changed), open it and FIND_DEVICE, until it answers or `timeout`
/// has passed (measured after the delay).
pub fn reconnect(
    conn: &dyn Connector,
    like: &PortInfo,
    delay: Duration,
    timeout: Duration,
    retry_every: Duration,
    timing: AckTiming,
) -> Result<(PortInfo, Session, DeviceInfo), UpgradeError> {
    tracing::info!(
        delay_ms = delay.as_millis() as u64,
        timeout_ms = timeout.as_millis() as u64,
        "reconnecting"
    );
    std::thread::sleep(delay);
    let deadline = Instant::now() + timeout;
    loop {
        match conn.list() {
            Ok(ports) => {
                for port in ports.into_iter().filter(|p| same_device(p, like)) {
                    let link = match conn.open(&port.path) {
                        Ok(l) => l,
                        Err(e) => {
                            tracing::debug!(path = %port.path, "reconnect open failed: {e}");
                            continue;
                        }
                    };
                    let mut session = Session::new(link, timing);
                    match session.find_device() {
                        Ok(info) => {
                            tracing::info!(path = %port.path, "reconnected");
                            return Ok((port, session, info));
                        }
                        Err(e) => {
                            tracing::debug!(path = %port.path, "reconnect FIND_DEVICE failed: {e}")
                        }
                    }
                }
            }
            Err(e) => tracing::debug!("port enumeration failed: {e}"),
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            tracing::warn!("reconnect timed out");
            return Err(UpgradeError::Reconnect);
        }
        std::thread::sleep(retry_every.min(left));
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FoundDevice {
    pub port: PortInfo,
    pub info: DeviceInfo,
    /// Whether the device echoed our request seq in its ack (None = unknown).
    pub echoes_seq: Option<bool>,
}

impl FoundDevice {
    pub fn is_flashable(&self) -> bool {
        is_flashable_name(&self.info.device_name)
    }
}

/// Whether a device name (case-insensitive) is a flashable Ascent model.
pub fn is_flashable_name(device_name: &str) -> bool {
    let n = device_name.to_ascii_lowercase();
    n == "ascent_lite" || n == "ascent_lite_plus"
}

/// Probe every candidate port with FIND_DEVICE only, closing each afterwards.
pub fn find_devices(
    conn: &dyn Connector,
    timing: AckTiming,
) -> Vec<Result<FoundDevice, (PortInfo, SessionError)>> {
    let ports = match conn.list() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("port enumeration failed: {e}");
            return vec![];
        }
    };
    ports
        .into_iter()
        .filter(|p| is_candidate(p.vid))
        .map(|port| {
            let link = match conn.open(&port.path) {
                Ok(l) => l,
                Err(e) => return Err((port, SessionError::Io(e))),
            };
            let mut session = Session::new(link, timing);
            match session.find_device() {
                Ok(info) => Ok(FoundDevice {
                    echoes_seq: session.echoes_seq(),
                    port,
                    info,
                }),
                Err(e) => Err((port, e)),
            }
        })
        .collect()
}
