//! Real serial-port connector (115200 8N1).

use crate::link::{Connector, Link, PortInfo};
use serialport::{SerialPort, SerialPortType};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

/// Port timeout for reads (and restored after each write).
const READ_TIMEOUT: Duration = Duration::from_millis(50);
/// Port timeout while writing a frame (a 1 MiB chunk can back-pressure).
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Give up writing one frame after this long in total.
const WRITE_DEADLINE: Duration = Duration::from_secs(30);

pub struct SerialConnector;

/// Write all of `buf`, treating `TimedOut`/`Interrupted` as "keep trying"
/// until `deadline` has passed in total (then `TimedOut`).
fn write_all_patiently<W: Write + ?Sized>(
    w: &mut W,
    buf: &[u8],
    deadline: Duration,
) -> io::Result<()> {
    let start = Instant::now();
    let mut rest = buf;
    while !rest.is_empty() {
        match w.write(rest) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(n) => rest = &rest[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
                ) =>
            {
                tracing::debug!(left = rest.len(), "serial write stalled ({e}); retrying");
            }
            Err(e) => return Err(e),
        }
        if !rest.is_empty() && start.elapsed() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("serial write stalled with {} bytes left", rest.len()),
            ));
        }
    }
    Ok(())
}

struct SerialLink(Box<dyn SerialPort>);

impl Link for SerialLink {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.0
            .set_timeout(WRITE_TIMEOUT)
            .map_err(io::Error::other)?;
        let result =
            write_all_patiently(&mut *self.0, buf, WRITE_DEADLINE).and_then(|()| self.0.flush());
        let restored = self.0.set_timeout(READ_TIMEOUT).map_err(io::Error::other);
        result.and(restored)
    }

    fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<usize> {
        self.0.set_timeout(timeout).map_err(io::Error::other)?;
        match self.0.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Ok(0),
            Err(e) => Err(e),
        }
    }
}

impl Connector for SerialConnector {
    fn list(&self) -> io::Result<Vec<PortInfo>> {
        let ports = serialport::available_ports().map_err(io::Error::other)?;
        Ok(ports
            .into_iter()
            .filter_map(|p| match p.port_type {
                // macOS lists both tty.* and cu.*; only cu.* is usable for outgoing use.
                SerialPortType::UsbPort(u)
                    if !cfg!(target_os = "macos") || p.port_name.starts_with("/dev/cu.") =>
                {
                    Some(PortInfo {
                        path: p.port_name,
                        vid: u.vid,
                        pid: u.pid,
                        serial: u.serial_number,
                    })
                }
                _ => None,
            })
            .collect())
    }

    fn open(&self, path: &str) -> io::Result<Box<dyn Link>> {
        let port = serialport::new(path, 115_200)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .timeout(READ_TIMEOUT)
            .open()
            .map_err(io::Error::other)?;
        Ok(Box::new(SerialLink(port)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Accepts at most 3 bytes per call, after `stalls` TimedOut errors.
    struct Flaky {
        stalls: u32,
        always_stall: bool,
        out: Vec<u8>,
    }

    impl Write for Flaky {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.always_stall || self.stalls > 0 {
                self.stalls = self.stalls.saturating_sub(1);
                return Err(io::ErrorKind::TimedOut.into());
            }
            self.stalls = 1; // stall again before the next piece
            let n = buf.len().min(3);
            self.out.extend_from_slice(&buf[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_all_retries_timeouts() {
        let mut w = Flaky {
            stalls: 4,
            always_stall: false,
            out: Vec::new(),
        };
        let data: Vec<u8> = (0..10).collect();
        write_all_patiently(&mut w, &data, Duration::from_secs(5)).unwrap();
        assert_eq!(w.out, data);
    }

    #[test]
    fn write_all_gives_up_after_deadline() {
        let mut w = Flaky {
            stalls: 0,
            always_stall: true,
            out: Vec::new(),
        };
        let t = Instant::now();
        let e = write_all_patiently(&mut w, b"abc", Duration::from_millis(20)).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert!(t.elapsed() >= Duration::from_millis(20));
        assert!(t.elapsed() < Duration::from_secs(1));
    }
}
