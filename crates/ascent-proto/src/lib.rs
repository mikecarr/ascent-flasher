//! Wire protocol for the Caddx Ascent VTX (unofficial, reverse-engineered).

pub mod command;
pub mod discovery;
pub mod frame;
pub mod link;
#[cfg(feature = "logging")]
pub mod logging;
pub mod payload;
pub mod reader;
#[cfg(feature = "serial")]
pub mod serial;
pub mod session;
#[cfg(feature = "sim")]
pub mod sim;

pub use command::Command;
pub use payload::{
    file_info, reboot_mode, status_message, DeviceInfo, FileDataInfo, PayloadError, UpgradeStatus,
};

pub use frame::{
    decode_header, encode_ack, encode_request, frame_crc, Frame, Header, HEADER_LEN, MAGIC,
    MAX_FRAME_LEN, UNUSED, VERSION,
};
pub use link::{Connector, Link, PortInfo};
pub use reader::FrameReader;
pub use session::{AckTiming, Session, SessionError};
