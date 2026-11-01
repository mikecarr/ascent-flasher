//! Transport abstraction: a byte link to a device and a way to find/open ports.

use std::io;
use std::time::Duration;

/// A bidirectional byte link (e.g. a serial port).
pub trait Link: Send {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()>;
    /// Read available bytes, waiting up to `timeout`. `Ok(0)` means timeout
    /// with no data.
    fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<usize>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct PortInfo {
    pub path: String,
    pub vid: u16,
    pub pid: u16,
    pub serial: Option<String>,
}

/// Enumerates and opens ports.
pub trait Connector: Send + Sync {
    fn list(&self) -> io::Result<Vec<PortInfo>>;
    fn open(&self, path: &str) -> io::Result<Box<dyn Link>>;
}
