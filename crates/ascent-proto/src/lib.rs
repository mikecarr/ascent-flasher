//! Wire protocol for the Caddx Ascent VTX (unofficial, reverse-engineered).

pub mod frame;
pub mod reader;

pub use frame::{
    decode_header, encode_request, frame_crc, Frame, Header, HEADER_LEN, MAGIC, MAX_FRAME_LEN,
    UNUSED, VERSION,
};
