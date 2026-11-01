use ascent_proto::reader::FrameReader;
use ascent_proto::{encode_request, HEADER_LEN};

#[test]
fn reads_frame_split_across_pushes() {
    let payload: Vec<u8> = (0..100u8).collect();
    let bytes = encode_request(7, &payload, 1, 0);
    let mut r = FrameReader::new();
    r.push(&bytes[..10]);
    assert!(r.next_frame().is_none());
    r.push(&bytes[10..40]);
    assert!(r.next_frame().is_none());
    r.push(&bytes[40..]);
    let f = r.next_frame().expect("frame");
    assert_eq!(f.payload, payload);
    assert_eq!(f.header.command, 7);
    assert!(r.next_frame().is_none());
}

#[test]
fn skips_leading_garbage() {
    let mut r = FrameReader::new();
    r.push(b"U-Boot 2020\r\n\x00\xff");
    r.push(&encode_request(3, b"hello", 2, 0));
    let f = r.next_frame().expect("frame");
    assert_eq!(f.payload, b"hello");
    assert_eq!(f.header.seq, 2);
}

#[test]
fn skips_oversized_length() {
    let mut bad = encode_request(1, &[], 1, 0);
    bad[20..24].copy_from_slice(&6000u32.to_le_bytes());
    assert_eq!(bad.len(), HEADER_LEN);
    let mut r = FrameReader::new();
    r.push(&bad);
    r.push(&encode_request(9, b"ok", 5, 0));
    let f = r.next_frame().expect("frame");
    assert_eq!(f.header.command, 9);
    assert_eq!(f.payload, b"ok");
}

#[test]
fn two_frames_in_one_push() {
    let mut buf = encode_request(1, b"aa", 1, 0);
    buf.extend(encode_request(2, b"bbb", 2, 0));
    let mut r = FrameReader::new();
    r.push(&buf);
    assert_eq!(r.next_frame().unwrap().payload, b"aa");
    assert_eq!(r.next_frame().unwrap().payload, b"bbb");
    assert!(r.next_frame().is_none());
}
