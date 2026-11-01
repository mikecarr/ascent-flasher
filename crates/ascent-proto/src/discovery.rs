//! Finding Ascent devices: VID filter plus a FIND_DEVICE probe (nothing else).

use crate::link::{Connector, PortInfo};
use crate::payload::DeviceInfo;
use crate::session::{AckTiming, Session, SessionError};

/// USB vendor IDs that may be an Ascent device.
pub fn is_candidate(vid: u16) -> bool {
    matches!(vid, 0x1D6B..=0x1D7B | 0x1D80..=0x1D84)
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
