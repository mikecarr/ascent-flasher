//! Wire protocol for the Caddx Ascent VTX (unofficial, reverse-engineered).

pub mod command;
pub mod frame;
pub mod payload;
pub mod reader;

pub use command::Command;
pub use payload::{
    file_info, reboot_mode, status_message, DeviceInfo, FileDataInfo, PayloadError, UpgradeStatus,
};

pub use frame::{
    decode_header, encode_request, frame_crc, Frame, Header, HEADER_LEN, MAGIC, MAX_FRAME_LEN,
    UNUSED, VERSION,
};
