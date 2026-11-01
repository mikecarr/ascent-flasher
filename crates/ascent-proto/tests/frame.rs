use ascent_proto::*;

#[test]
fn crc_matches_standard_vector() {
    assert_eq!(frame_crc(b"123456789", &[]), 0xCBF4_3926);
}

#[test]
fn encodes_find_device_header() {
    let f = encode_request(60, &[], 7, 0);
    assert_eq!(f.len(), 36);
    let expect: [u8; 32] = [
        0x4F, 0x54, 0x52, 0x41, 0xDC, 0x0C, 0x01, 0x00, 0x00, 0x00, 0xCD, 0xAB, 0x3C, 0x00, 0x00,
        0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];
    assert_eq!(&f[..32], &expect);
    let mut h = expect.to_vec();
    h.extend_from_slice(&[0; 4]);
    assert_eq!(&f[32..36], &frame_crc(&h, &[]).to_le_bytes());
}

#[test]
fn roundtrip_with_payload() {
    let payload: Vec<u8> = (0..328).map(|i| i as u8).collect();
    let f = encode_request(115, &payload, 3, 1);
    let hdr: [u8; 36] = f[..36].try_into().unwrap();
    let h = decode_header(&hdr).unwrap();
    assert_eq!(h.command, 115);
    assert_eq!(h.length, 328);
    assert_eq!(h.seq, 3);
    assert_eq!(h.retry, 1);
    assert_eq!(h.msg_type, 1);
    let mut z = hdr.to_vec();
    z[32..36].fill(0);
    assert_eq!(frame_crc(&z, &f[36..]), h.crc32);
    assert_eq!(&f[36..], &payload[..]);
}

#[test]
fn rejects_bad_magic() {
    let f = encode_request(60, &[], 0, 0);
    let mut hdr: [u8; 36] = f[..36].try_into().unwrap();
    hdr[0] ^= 0xFF;
    assert!(decode_header(&hdr).is_none());
}

#[test]
fn encodes_ack_type() {
    let f = encode_ack(60, &[1, 2, 3], 9);
    let hdr: [u8; 36] = f[..36].try_into().unwrap();
    let h = decode_header(&hdr).unwrap();
    assert_eq!(h.msg_type, 2);
    assert_eq!(h.command, 60);
    assert_eq!(h.format, 2);
    assert_eq!(h.length, 3);
    assert_eq!(h.seq, 9);
    assert_eq!(h.retry, 0);
    let mut zeroed = hdr;
    zeroed[32..36].fill(0);
    assert_eq!(h.crc32, frame_crc(&zeroed, &[1, 2, 3]));
    assert_eq!(&f[36..], &[1, 2, 3]);
}
