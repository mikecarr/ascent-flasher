//! Real serial-port connector (115200 8N1).

use crate::link::{Connector, Link, PortInfo};
use serialport::{SerialPort, SerialPortType};
use std::io::{self, Read, Write};
use std::time::Duration;

pub struct SerialConnector;

struct SerialLink(Box<dyn SerialPort>);

impl Link for SerialLink {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.0.write_all(buf)?;
        self.0.flush()
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
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(io::Error::other)?;
        Ok(Box::new(SerialLink(port)))
    }
}
